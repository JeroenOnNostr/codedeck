import { getPublicKey } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import * as nip19 from 'nostr-tools/nip19';
import { createRumor, createSeal, createWrap, unwrapEvent } from 'nostr-tools/nip59';
import type { DmMessage } from '../types';
import { dmLog, dmWarn } from './debugLog';

let pool: SimplePool | null = null;
let subscription: ReturnType<SimplePool['subscribeMany']> | null = null;
let ownPubkey: string | null = null;
let ownSkBytes: Uint8Array | null = null;

// Diagnostic counters
let eventsReceived = 0;
let giftWrapFailures = 0;
let lastFilter: Record<string, unknown> | null = null;

/** Rumor IDs we sent — skip these from relay delivery. Map<id, timestamp> for TTL eviction. */
const sentRumorIds = new Map<string, number>();
const RUMOR_TTL_MS = 600_000; // 10 minutes

/** Periodic cleanup of sentRumorIds (runs every 5 minutes regardless of send activity). */
let rumorCleanupTimer: ReturnType<typeof setInterval> | null = null;
function ensureRumorCleanup(): void {
  if (rumorCleanupTimer) { return; }
  rumorCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, ts] of sentRumorIds) {
      if (now - ts > RUMOR_TTL_MS) sentRumorIds.delete(id);
    }
  }, 300_000); // every 5 minutes
}

type MessageHandler = (msg: DmMessage) => void;
let onMessage: MessageHandler | null = null;

type StatusHandler = (status: 'disconnected' | 'connecting' | 'connected') => void;
let onStatus: StatusHandler | null = null;

/** Convert nsec bech32 or 64-char hex to Uint8Array. Returns null on invalid input. */
export function parsePrivateKey(input: string): Uint8Array | null {
  const trimmed = input.trim();

  // nsec bech32
  if (trimmed.startsWith('nsec1')) {
    try {
      const decoded = nip19.decode(trimmed);
      if (decoded.type === 'nsec') return decoded.data as Uint8Array;
    } catch {
      return null;
    }
    return null;
  }

  // 64-char hex
  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    return hexToBytes(trimmed);
  }

  return null;
}

/** Convert npub bech32 or 64-char hex to hex pubkey string. Returns null on invalid input. */
export function parsePublicKey(input: string): string | null {
  const trimmed = input.trim();

  // npub bech32
  if (trimmed.startsWith('npub1')) {
    try {
      const decoded = nip19.decode(trimmed);
      if (decoded.type === 'npub') return decoded.data as string;
    } catch { /* invalid bech32 */ }
    return null;
  }

  // 64-char hex
  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  return null;
}

/** Derive hex public key from secret key bytes. */
export function getPubkeyHex(sk: Uint8Array): string {
  return getPublicKey(sk);
}

/** Compute deterministic conversation ID from two hex pubkeys. */
export function conversationId(pubkeyA: string, pubkeyB: string): string {
  return [pubkeyA, pubkeyB].sort().join(':');
}

/** Register callbacks for incoming messages and connection status changes. */
export function setHandlers(msgHandler: MessageHandler, statusHandler: StatusHandler): void {
  onMessage = msgHandler;
  onStatus = statusHandler;
}

/**
 * Connect to relays and subscribe to incoming gift wraps (kind 1059).
 * Uses enableReconnect for automatic reconnection with exponential backoff.
 * Uses `since` filter to avoid reprocessing messages already persisted locally.
 */
export function connect(privateKeyHex: string, relays: string[], sinceTimestamp?: number): void {
  disconnect();

  const sk = hexToBytes(privateKeyHex);
  ownSkBytes = sk;
  ownPubkey = getPublicKey(sk);

  dmLog('Nostr', `Connecting to relays: [${relays.join(', ')}] pubkey: ${ownPubkey}`);
  onStatus?.('connecting');
  ensureRumorCleanup();
  eventsReceived = 0;
  giftWrapFailures = 0;

  // Enable auto-reconnect with exponential backoff (10s → 60s)
  pool = new SimplePool({ enableReconnect: true });

  const filter: Record<string, unknown> = {
    kinds: [1059],
    '#p': [ownPubkey],
  };

  // Only fetch events after last known message to avoid replaying history
  if (sinceTimestamp && sinceTimestamp > 0) {
    filter.since = sinceTimestamp;
  }
  lastFilter = filter;
  const sinceStr = filter.since ? `${filter.since} (${new Date((filter.since as number) * 1000).toISOString()})` : 'none (fetching all)';
  dmLog('Nostr', `Subscribe filter: ${JSON.stringify(filter)} — since: ${sinceStr}`);

  subscription = pool.subscribeMany(
    relays,
    filter as Parameters<SimplePool['subscribeMany']>[1],
    {
      onevent(event) {
        eventsReceived++;
        if (!ownSkBytes) {
          dmWarn('Nostr', 'Received gift wrap but ownSkBytes is null — dropping');
          return;
        }
        dmLog('Nostr', `Received gift wrap #${eventsReceived}: ${event.id.slice(0, 12)}... kind=${event.kind} pubkey=${event.pubkey.slice(0, 12)} created_at=${event.created_at} filter.since=${filter.since ?? 'none'}`);
        const msg = processGiftWrap(event, ownSkBytes);
        if (msg) {
          // Skip self-wraps for messages we sent — the local addMessage already covers these
          if (sentRumorIds.has(msg.id)) {
            dmLog('Nostr', `Skipping self-wrap for sent message ${msg.id.slice(0, 12)}...`);
            return;
          }
          dmLog('Nostr', `Processed DM from ${msg.sender_pubkey.slice(0, 8)}... (${msg.content.length} chars)`);
          onMessage?.(msg);
        }
      },
      oneose() {
        dmLog('Nostr', `Subscription EOSE — connected (${eventsReceived} historical events)`);
        onStatus?.('connected');
      },
      onclose(reasons) {
        dmWarn('Nostr', `Subscription closed — reasons: ${JSON.stringify(reasons)}`);
        // Pool will auto-reconnect if enableReconnect is true;
        // update status so the UI shows a reconnecting indicator
        onStatus?.('connecting');
      },
    },
  );
}

/** Close relay connections. */
export function disconnect(): void {
  if (subscription) {
    subscription.close();
    subscription = null;
  }
  if (pool) {
    pool.destroy();
    pool = null;
  }
  ownPubkey = null;
  ownSkBytes = null;
  if (rumorCleanupTimer) { clearInterval(rumorCleanupTimer); rumorCleanupTimer = null; }
  onStatus?.('disconnected');
}

/**
 * Send a NIP-17 DM.
 *
 * 1. Build kind 14 rumor template
 * 2. createRumor() once (deterministic ID for dedup)
 * 3. createSeal() + createWrap() for recipient
 * 4. createSeal() + createWrap() for self
 * 5. Publish both via pool, properly awaiting per-relay promises
 */
export async function sendDirectMessage(
  senderSkHex: string,
  recipientPubkey: string,
  content: string,
  relays: string[],
): Promise<DmMessage> {
  if (!pool) {
    pool = new SimplePool({ enableReconnect: true });
  }

  const senderSk = hexToBytes(senderSkHex);
  const senderPubkey = getPublicKey(senderSk);

  dmLog('DM Send', `Start — to: ${recipientPubkey.slice(0, 12)}..., from: ${senderPubkey.slice(0, 12)}..., relays: [${relays.join(', ')}], content: ${content.length} chars`);

  const rumorTemplate = {
    kind: 14,
    content,
    tags: [['p', recipientPubkey]],
  };

  // Create rumor ONCE so the rumor.id is consistent for dedup
  const rumor = createRumor(rumorTemplate, senderSk);
  dmLog('DM Send', `Rumor created — id: ${rumor.id.slice(0, 12)}..., kind: ${rumor.kind}, tags: ${rumor.tags.length}`);

  // Track this rumor ID so we skip the self-wrap when it arrives from relay
  sentRumorIds.set(rumor.id, Date.now());

  // Seal + wrap for recipient
  const sealForRecipient = createSeal(rumor, senderSk, recipientPubkey);
  const wrapForRecipient = createWrap(sealForRecipient, recipientPubkey);
  dmLog('DM Send', `Wrap for recipient — wrapId: ${wrapForRecipient.id.slice(0, 12)}..., to: ${recipientPubkey.slice(0, 12)}..., wrapPubkey: ${wrapForRecipient.pubkey.slice(0, 12)}...`);

  // Seal + wrap for self (so sender sees their own message on other devices)
  const sealForSelf = createSeal(rumor, senderSk, senderPubkey);
  const wrapForSelf = createWrap(sealForSelf, senderPubkey);
  dmLog('DM Send', `Wrap for self — wrapId: ${wrapForSelf.id.slice(0, 12)}..., to: ${senderPubkey.slice(0, 12)}...`);

  // pool.publish() returns Promise<string>[] (one per relay) — spread to await each
  const recipientPromises = pool.publish(relays, wrapForRecipient);
  const selfPromises = pool.publish(relays, wrapForSelf);
  const publishResults = await Promise.allSettled([...recipientPromises, ...selfPromises]);

  // Log per-relay results: first N are recipient wrap, last N are self wrap
  const n = relays.length;
  for (let i = 0; i < publishResults.length; i++) {
    const r = publishResults[i];
    const relay = relays[i % n];
    const target = i < n ? 'recipient' : 'self';
    if (r.status === 'fulfilled') {
      dmLog('DM Send', `✓ ${relay} (${target} wrap) — OK`);
    } else {
      dmWarn('DM Send', `✗ ${relay} (${target} wrap) — FAILED: ${r.reason}`);
    }
  }

  const succeeded = publishResults.filter(r => r.status === 'fulfilled').length;
  const failed = publishResults.filter(r => r.status === 'rejected').length;

  const convId = conversationId(senderPubkey, recipientPubkey);
  const status = succeeded > 0 ? 'sent' : 'failed';
  dmLog('DM Send', `Done — rumor: ${rumor.id.slice(0, 12)}..., status: ${status}, ${succeeded} OK / ${failed} failed`);

  return {
    id: rumor.id,
    conversation_id: convId,
    sender_pubkey: senderPubkey,
    content,
    timestamp: new Date().toISOString(),
    status,
  };
}

/** Decrypt a kind 1059 gift wrap event and extract the DM message. */
function processGiftWrap(event: Parameters<typeof unwrapEvent>[0], recipientSk: Uint8Array): DmMessage | null {
  try {
    const rumor = unwrapEvent(event, recipientSk);
    dmLog('DM Recv', `Unwrapped gift wrap ${event.id.slice(0, 12)}... — rumor kind: ${rumor.kind}, sender: ${rumor.pubkey.slice(0, 12)}..., content: ${rumor.content.length} chars, created_at: ${rumor.created_at} (${new Date((rumor.created_at || 0) * 1000).toISOString()})`);

    if (rumor.kind !== 14) {
      dmWarn('DM Recv', `Unexpected rumor kind ${rumor.kind} (expected 14) — dropping gift wrap ${event.id.slice(0, 12)}...`);
      return null;
    }

    const senderPubkey = rumor.pubkey;
    const recipientPubkey = getPublicKey(recipientSk);

    // Find the other participant from p-tags or sender
    const pTags = (rumor.tags || []).filter((t: string[]) => t[0] === 'p').map((t: string[]) => t[1]);
    const otherPubkey = senderPubkey === recipientPubkey
      ? pTags[0] || senderPubkey
      : senderPubkey;

    const convId = conversationId(recipientPubkey, otherPubkey);

    return {
      id: rumor.id || event.id,
      conversation_id: convId,
      sender_pubkey: senderPubkey,
      content: rumor.content,
      timestamp: new Date((rumor.created_at || 0) * 1000).toISOString(),
      status: 'delivered',
    };
  } catch (err) {
    giftWrapFailures++;
    const errMsg = err instanceof Error ? err.message : String(err);
    const pTags = (event.tags || []).filter((t: string[]) => t[0] === 'p').map((t: string[]) => t[1].slice(0, 12));
    dmWarn('DM Recv', `Failed to unwrap gift wrap ${event.id?.slice(0, 12)}... (failure #${giftWrapFailures}) — wrapPubkey: ${event.pubkey?.slice(0, 12)}..., #p tags: [${pTags.join(', ')}], error: ${errMsg}`);
    return null;
  }
}

/** Get diagnostic info for debugging DM connectivity. */
export function getDebugInfo(): {
  pubkey: string | null;
  filter: Record<string, unknown> | null;
  eventsReceived: number;
  giftWrapFailures: number;
  relayStatus: Record<string, boolean>;
} {
  const relayStatus: Record<string, boolean> = {};
  if (pool) {
    pool.listConnectionStatus().forEach((connected, url) => {
      relayStatus[url] = connected;
    });
  }
  return { pubkey: ownPubkey, filter: lastFilter, eventsReceived, giftWrapFailures, relayStatus };
}

// --- Helpers ---

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}
