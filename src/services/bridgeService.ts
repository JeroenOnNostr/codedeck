/**
 * Bridge Service — connects Codedeck to remote Claude Code sessions via Nostr.
 *
 * Subscribes to output events from a paired bridge (VSCode extension) and
 * publishes input events back. All communication is NIP-44 encrypted.
 *
 * Protocol:
 * - Session list: NIP-33 replaceable events (kind 30515, d-tag = machine name)
 * - Output: Regular events (kind 29515) with seq counter per session
 * - History: Request/response pattern for catch-up on connect
 */

import { SimplePool } from 'nostr-tools/pool';
import { getPublicKey } from 'nostr-tools/pure';
import { encrypt, decrypt, getConversationKey } from 'nostr-tools/nip44';
import { finalizeEvent } from 'nostr-tools/pure';
import type {
  AgentMode,
  EffortLevel,
  RemoteMachine,
  RemoteSessionInfo,
  RemoteOutputEntry,
  BridgeInboundMessage,
  BridgeOutboundMessage,
  DeviceConfig,
} from '../types';
import { chunkBase64 } from '../utils/imageUtils';
import { uploadToBlossom, DEFAULT_BLOSSOM_SERVER } from '../utils/blossomUpload';

// Must match the bridge extension's event kinds.
// Kind 4515 is in the regular range (1-9999) so relays store and forward reliably.
// Previously 29515 which is ephemeral (20000-29999) — relays dropped these events.
const OUTPUT_EVENT_KIND = 4515;
const SESSION_LIST_EVENT_KIND = 30515;

type SessionListHandler = (msg: { machine: string; sessions: RemoteSessionInfo[]; authStatus?: import('../types').AuthStatus; protocolVersion?: number }) => void;
type OutputHandler = (sessionId: string, entry: RemoteOutputEntry, seq: number) => void;
type HistoryHandler = (sessionId: string, entries: Array<{ seq: number; entry: RemoteOutputEntry }>, totalEntries: number, chunkIndex?: number, totalChunks?: number, requestId?: string) => void;
type StatusHandler = (machine: string, status: 'connected' | 'disconnected' | 'connecting') => void;
type SessionPendingHandler = (pendingId: string, machine: string, createdAt: string) => void;
type SessionReadyHandler = (pendingId: string, session: RemoteSessionInfo) => void;
type SessionFailedHandler = (pendingId: string, reason: string) => void;
type InputFailedHandler = (sessionId: string, reason: 'no-terminal' | 'expired') => void;
type CloseSessionAckHandler = (sessionId: string, success: boolean) => void;
type SessionReplacedHandler = (oldSessionId: string, newSession: RemoteSessionInfo) => void;
type ModeConfirmedHandler = (sessionId: string, mode: import('../types').AgentMode) => void;
type EffortConfirmedHandler = (sessionId: string, level: import('../types').EffortLevel) => void;
type ModelConfirmedHandler = (sessionId: string, model: string) => void;
type UsageHandler = (sessionId: string, usage: import('../types').UsageData) => void;
type CredentialsAckHandler = (machine: string, success: boolean, hasAnthropicKey: boolean, hasGithubPat: boolean, keyValid?: boolean, error?: string) => void;
type PairAckHandler = (machine: string, ok: boolean, reason?: string) => void;

let pool: SimplePool | null = null;
const subscriptions: Map<string, ReturnType<SimplePool['subscribeMany']>> = new Map();
let generation = 0; // incremented on re-init to abort in-flight publishes

let onSessionList: SessionListHandler | null = null;
let onOutput: OutputHandler | null = null;
let onHistory: HistoryHandler | null = null;
let onStatus: StatusHandler | null = null;
let onSessionPending: SessionPendingHandler | null = null;
let onSessionReady: SessionReadyHandler | null = null;
let onSessionFailed: SessionFailedHandler | null = null;
let onInputFailed: InputFailedHandler | null = null;
let onCloseSessionAck: CloseSessionAckHandler | null = null;
let onSessionReplaced: SessionReplacedHandler | null = null;
let onModeConfirmed: ModeConfirmedHandler | null = null;
let onEffortConfirmed: EffortConfirmedHandler | null = null;
let onModelConfirmed: ModelConfirmedHandler | null = null;
let onUsage: UsageHandler | null = null;
let onCredentialsAck: CredentialsAckHandler | null = null;
let onPairAck: PairAckHandler | null = null;

let ownSecretKeyBytes: Uint8Array | null = null;
let ownPubkeyHex: string | null = null;

// Track latest event timestamp per machine for `since` filter on reconnect
const lastSeenTimestamps: Map<string, number> = new Map();

// Track latest session list event created_at per machine for staleness detection
const lastSessionListTimestamps: Map<string, number> = new Map();

// Periodic staleness check timers per machine
const stalenessTimers: Map<string, ReturnType<typeof setInterval>> = new Map();

// Bridge heartbeat is 60s; consider stale after ~2.5 missed heartbeats
const STALENESS_THRESHOLD_S = 150;
const STALENESS_CHECK_INTERVAL_MS = 60_000;

// Track consecutive decryption failures per machine to detect key mismatch
const consecutiveDecryptFailures: Map<string, number> = new Map();
const DECRYPT_FAILURE_THRESHOLD = 5;

/**
 * Initialize the bridge service with the phone's Nostr identity.
 */
export function initBridge(privateKeyHex: string): void {
  const newKeyBytes = hexToBytes(privateKeyHex);
  const newPubkey = getPublicKey(newKeyBytes);

  // If re-initializing with a different key, tear down old subscriptions
  if (ownPubkeyHex && ownPubkeyHex !== newPubkey) {
    disconnectAll();
  }
  generation++; // invalidate any in-flight publishes from previous init

  ownSecretKeyBytes = newKeyBytes;
  ownPubkeyHex = newPubkey;

  if (!pool) {
    pool = new SimplePool({ enableReconnect: true });
  }
}

/**
 * Register event handlers.
 */
export function setBridgeHandlers(
  sessionListHandler: SessionListHandler,
  outputHandler: OutputHandler,
  statusHandler: StatusHandler,
  historyHandler?: HistoryHandler,
  sessionPendingHandler?: SessionPendingHandler,
  sessionReadyHandler?: SessionReadyHandler,
  sessionFailedHandler?: SessionFailedHandler,
  inputFailedHandler?: InputFailedHandler,
  closeSessionAckHandler?: CloseSessionAckHandler,
  sessionReplacedHandler?: SessionReplacedHandler,
  modeConfirmedHandler?: ModeConfirmedHandler,
  effortConfirmedHandler?: EffortConfirmedHandler,
  modelConfirmedHandler?: ModelConfirmedHandler,
  credentialsAckHandler?: CredentialsAckHandler,
  pairAckHandler?: PairAckHandler,
  usageHandler?: UsageHandler,
): void {
  onSessionList = sessionListHandler;
  onOutput = outputHandler;
  onStatus = statusHandler;
  onHistory = historyHandler ?? null;
  onSessionPending = sessionPendingHandler ?? null;
  onSessionReady = sessionReadyHandler ?? null;
  onSessionFailed = sessionFailedHandler ?? null;
  onInputFailed = inputFailedHandler ?? null;
  onCloseSessionAck = closeSessionAckHandler ?? null;
  onSessionReplaced = sessionReplacedHandler ?? null;
  onModeConfirmed = modeConfirmedHandler ?? null;
  onEffortConfirmed = effortConfirmedHandler ?? null;
  onModelConfirmed = modelConfirmedHandler ?? null;
  onUsage = usageHandler ?? null;
  onCredentialsAck = credentialsAckHandler ?? null;
  onPairAck = pairAckHandler ?? null;
}

/**
 * Connect to a remote machine's bridge via Nostr relays.
 */
export function connectToMachine(machine: RemoteMachine): void {
  if (!pool || !ownSecretKeyBytes || !ownPubkeyHex) {
    console.error('[Bridge] Not initialized. Call initBridge() first.');
    return;
  }

  // Disconnect existing subscription for this machine
  disconnectFromMachine(machine.pubkeyHex);

  onStatus?.(machine.hostname, 'connecting');

  // Use `since` filter to avoid replaying all stored events on reconnect.
  // On first connect, fall back to a 5-minute window rather than fetching
  // everything the relay has ever stored for this author.
  const lastSeen = lastSeenTimestamps.get(machine.pubkeyHex);
  const since = lastSeen && lastSeen > 0
    ? lastSeen - 5  // 5s grace before last-seen
    : Math.floor(Date.now() / 1000) - 300;  // fallback: 5-minute window
  const filter: Record<string, unknown> = {
    kinds: [OUTPUT_EVENT_KIND, SESSION_LIST_EVENT_KIND],
    '#p': [ownPubkeyHex],
    authors: [machine.pubkeyHex],
    since,
  };

  // Capture generation so callbacks become no-ops after a key change / re-init
  const myGen = generation;

  const sub = pool.subscribeMany(
    machine.relays,
    filter as Parameters<SimplePool['subscribeMany']>[1],
    {
      onevent(event) {
        if (myGen !== generation) { return; }
        handleBridgeEvent(event, machine);
      },
      oneose() {
        if (myGen !== generation) { return; }
        // EOSE only means the relay delivered cached events — check freshness
        // of the latest session list to determine if bridge is actually alive.
        evaluateMachineStatus(machine);
      },
      onclose(reasons) {
        if (myGen !== generation) { return; }
        console.warn('[Bridge] Subscription closed:', reasons);
        onStatus?.(machine.hostname, 'connecting');
      },
    },
  );

  subscriptions.set(machine.pubkeyHex, sub);

  // Start periodic staleness check for this machine
  const existingTimer = stalenessTimers.get(machine.pubkeyHex);
  if (existingTimer) { clearInterval(existingTimer); }
  const timer = setInterval(() => {
    evaluateMachineStatus(machine);
  }, STALENESS_CHECK_INTERVAL_MS);
  stalenessTimers.set(machine.pubkeyHex, timer);
}

/**
 * Disconnect from a specific machine.
 */
export function disconnectFromMachine(pubkeyHex: string): void {
  const sub = subscriptions.get(pubkeyHex);
  if (sub) {
    sub.close();
    subscriptions.delete(pubkeyHex);
  }
  const timer = stalenessTimers.get(pubkeyHex);
  if (timer) { clearInterval(timer); stalenessTimers.delete(pubkeyHex); }
}

/**
 * Reconnect all currently tracked machine subscriptions.
 * Called on foreground resume since Android kills WebSockets after ~30s background.
 */
export function reconnectAllMachines(machines: RemoteMachine[]): void {
  if (!pool || !ownSecretKeyBytes || !ownPubkeyHex) { return; }
  for (const machine of machines) {
    connectToMachine(machine);
  }
}

/** Whether the bridge has any active relay subscriptions. */
export function hasActiveSubscriptions(): boolean {
  return subscriptions.size > 0;
}

/**
 * Disconnect from all machines.
 */
export function disconnectAll(): void {
  for (const [key, sub] of subscriptions) {
    sub.close();
    subscriptions.delete(key);
  }
  for (const timer of stalenessTimers.values()) { clearInterval(timer); }
  stalenessTimers.clear();
  if (pool) {
    pool.destroy();
    pool = null;
  }
}

/**
 * Send a message to a Claude Code session on a remote machine.
 */
export async function sendRemoteInput(
  machine: RemoteMachine,
  sessionId: string,
  text: string,
): Promise<void> {
  const msg: BridgeOutboundMessage = { type: 'input', sessionId, text };
  await publishToMachine(machine, msg);
}

/**
 * Send a free-text answer to a pending AskUserQuestion. The bridge selects
 * the "Type something" TUI option, waits for the mode switch, then sends text.
 */
export async function sendRemoteQuestionInput(
  machine: RemoteMachine,
  sessionId: string,
  text: string,
  optionCount: number,
): Promise<void> {
  const msg: BridgeOutboundMessage = { type: 'question-input', sessionId, text, optionCount };
  await publishToMachine(machine, msg);
}

/**
 * Interrupt a running session (equivalent to Ctrl+C / stop button).
 */
export async function sendInterrupt(
  machine: RemoteMachine,
  sessionId: string,
): Promise<void> {
  const msg: BridgeOutboundMessage = { type: 'interrupt', sessionId };
  await publishToMachine(machine, msg);
}

/**
 * Send a single raw keypress to a Claude Code session (plan approval, question selection).
 * Routed through sendKeypress on the bridge — no Escape/Enter wrapping.
 */
export async function sendRemoteKeypress(
  machine: RemoteMachine,
  sessionId: string,
  key: string,
  context?: 'plan-approval' | 'exit-plan' | 'question',
): Promise<void> {
  const msg: BridgeOutboundMessage = { type: 'keypress', sessionId, key, ...(context && { context }) };
  await publishToMachine(machine, msg);
}

/**
 * Send a permission response to a remote machine.
 */
export async function sendRemotePermissionResponse(
  machine: RemoteMachine,
  sessionId: string,
  requestId: string,
  allow: boolean,
  modifier?: 'always' | 'never',
): Promise<void> {
  const msg: BridgeOutboundMessage = { type: 'permission-res', sessionId, requestId, allow, modifier };
  await publishToMachine(machine, msg);
}

/**
 * Send a mode change to a remote machine.
 */
export async function sendRemoteModeChange(
  machine: RemoteMachine,
  sessionId: string,
  mode: AgentMode,
): Promise<void> {
  const msg: BridgeOutboundMessage = { type: 'mode', sessionId, mode };
  await publishToMachine(machine, msg);
}

/**
 * Send an effort level change to a remote machine.
 */
export async function sendRemoteEffortChange(
  machine: RemoteMachine,
  sessionId: string,
  level: EffortLevel,
): Promise<void> {
  const msg: BridgeOutboundMessage = { type: 'effort', sessionId, level };
  await publishToMachine(machine, msg);
}

/**
 * Send a model change to a remote machine (switches the session's Claude model mid-session).
 */
export async function sendRemoteModelChange(
  machine: RemoteMachine,
  sessionId: string,
  model: string,
): Promise<void> {
  const msg: BridgeOutboundMessage = { type: 'model', sessionId, model };
  await publishToMachine(machine, msg);
}

/**
 * Request a fresh subscription-usage snapshot for a session. The bridge responds (when supported)
 * with a `usage` message handled by onUsage.
 */
export async function sendUsageRequest(
  machine: RemoteMachine,
  sessionId: string,
): Promise<void> {
  const msg: BridgeOutboundMessage = { type: 'usage-request', sessionId };
  await publishToMachine(machine, msg);
}

/**
 * Request a new Claude Code terminal session on a remote machine.
 * The bridge will open a Claude Code terminal in the VSCode workspace.
 */
export async function sendCreateSessionRequest(
  machine: RemoteMachine,
  defaultEffort?: EffortLevel,
  model?: string,
  testSession?: boolean,
): Promise<void> {
  const msg: BridgeOutboundMessage = { type: 'create-session', defaultEffort, model, testSession };
  await publishToMachine(machine, msg);
}

/**
 * Request the bridge to close (dispose) a session's terminal.
 */
export async function sendCloseSessionRequest(
  machine: RemoteMachine,
  sessionId: string,
): Promise<void> {
  const msg: BridgeOutboundMessage = { type: 'close-session', sessionId };
  await publishToMachine(machine, msg);
}

/**
 * Request the bridge to re-scan and re-publish its session list.
 */
export async function sendRefreshRequest(
  machine: RemoteMachine,
): Promise<void> {
  const msg: BridgeOutboundMessage = { type: 'refresh-sessions' };
  await publishToMachine(machine, msg);
}

/**
 * Request history for a session from a remote machine.
 * The bridge will respond with a history message containing past entries.
 */
export async function sendHistoryRequest(
  machine: RemoteMachine,
  sessionId: string,
  afterSeq?: number,
): Promise<void> {
  const msg: BridgeOutboundMessage = { type: 'history-request', sessionId, afterSeq };
  await publishToMachine(machine, msg);
}

/**
 * Send an image attachment to a Claude Code session on a remote machine.
 *
 * Primary path: AES-256-GCM encrypt → upload to Blossom server → send hash + key/IV reference.
 * Fallback: chunk base64 into relay-safe pieces (legacy, if Blossom fails).
 */
export async function sendRemoteImage(
  machine: RemoteMachine,
  sessionId: string,
  text: string,
  base64: string,
  filename: string,
  mimeType: string,
  blossomServer?: string,
): Promise<void> {
  if (!ownSecretKeyBytes) {
    console.error('[Bridge] Not initialized — cannot upload image');
    return;
  }

  // Try Blossom first (encrypted upload)
  try {
    const server = blossomServer || DEFAULT_BLOSSOM_SERVER;
    const result = await uploadToBlossom(base64, ownSecretKeyBytes, server);
    const sizeBytes = Math.round(base64.length * 0.75);

    const msg: BridgeOutboundMessage = {
      type: 'upload-image',
      sessionId,
      hash: result.hash,
      url: result.url,
      key: result.key,
      iv: result.iv,
      filename,
      mimeType,
      text,
      sizeBytes,
    };
    await publishToMachine(machine, msg);
    console.log(`[Bridge] Image uploaded via Blossom: ${result.url} (${sizeBytes} bytes)`);
    return;
  } catch (err) {
    console.warn('[Bridge] Blossom upload failed, falling back to relay chunking:', err);
  }

  // Fallback: legacy chunk-based relay transport
  const uploadId = crypto.randomUUID();
  const chunks = chunkBase64(base64);

  for (let i = 0; i < chunks.length; i++) {
    const msg: BridgeOutboundMessage = {
      type: 'upload-image',
      sessionId,
      uploadId,
      filename,
      mimeType,
      base64Data: chunks[i],
      text: i === 0 ? text : '',
      chunkIndex: i,
      totalChunks: chunks.length,
    };
    await publishToMachine(machine, msg);

    // Inter-chunk delay to avoid relay rate-limiting
    if (i < chunks.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
}

/**
 * Send API credentials to a bridge machine (NIP-44 encrypted).
 */
export async function sendSetCredentials(
  machine: RemoteMachine,
  anthropicApiKey?: string | null,
  githubPat?: string | null,
): Promise<void> {
  const msg: BridgeOutboundMessage = { type: 'set-credentials', anthropicApiKey, githubPat };
  await publishToMachine(machine, msg);
}

/** Send the test-device config to the bridge (which device to target + how to build the app). */
export async function sendSetDeviceConfig(
  machine: RemoteMachine,
  config: DeviceConfig,
): Promise<void> {
  const msg: BridgeOutboundMessage = { type: 'set-device-config', config };
  await publishToMachine(machine, msg);
}

/**
 * Send a pairing request to a bridge (NIP-44 encrypted to the bridge pubkey).
 * Carries the phone's own identity plus the one-time token from the QR, so the
 * bridge can pair this phone with no manual npub entry. Returns true on publish.
 */
export async function sendPairRequest(
  machine: RemoteMachine,
  npub: string,
  pubkeyHex: string,
  label: string,
  token: string,
): Promise<boolean> {
  const msg: BridgeOutboundMessage = { type: 'pair-request', npub, pubkeyHex, label, token };
  return publishToMachine(machine, msg);
}

// --- Internal ---

async function publishToMachine(machine: RemoteMachine, msg: BridgeOutboundMessage): Promise<boolean> {
  if (!pool || !ownSecretKeyBytes) {
    console.error('[Bridge] Not initialized');
    return false;
  }

  const myGen = generation;
  // Cap on how long we'll wait for any relay to accept before giving up this send,
  // so a set of relays that never answer can't hang an awaited input forever.
  const PUBLISH_TIMEOUT_MS = 4000;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (myGen !== generation) { return false; } // pool was replaced during re-init
      const json = JSON.stringify(msg);
      const conversationKey = getConversationKey(ownSecretKeyBytes, machine.pubkeyHex);
      const ciphertext = encrypt(json, conversationKey);

      const event = finalizeEvent({
        kind: OUTPUT_EVENT_KIND, // phone→bridge messages use regular event kind
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', machine.pubkeyHex]],
        content: ciphertext,
      }, ownSecretKeyBytes);

      // pool.publish returns Promise<string>[] — resolve on the FIRST relay to accept
      // instead of waiting for the slowest. This is on the critical path of session
      // creation, so the round-trip should track the fastest relay, not the slowest.
      if (!pool || myGen !== generation) { return false; } // pool may have been destroyed
      const results = pool.publish(machine.relays, event);
      // Attach catch handlers so the losing relays don't surface as unhandled rejections
      // once Promise.any has already resolved on the first success.
      results.forEach((p, i) => p.catch((reason) => {
        console.warn(`[Bridge] Relay ${machine.relays[i]} rejected publish:`, reason);
      }));

      // Promise.any resolves as soon as any relay accepts; it only rejects
      // (AggregateError) when EVERY relay rejected. Race a timeout so an
      // unresponsive relay set can't hang an awaited send.
      let timer: ReturnType<typeof setTimeout> | undefined;
      let outcome: 'ack' | 'rejected' | 'timeout';
      try {
        outcome = await Promise.race([
          Promise.any(results).then(() => 'ack' as const, () => 'rejected' as const),
          new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), PUBLISH_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (timer) { clearTimeout(timer); }
      }

      if (outcome === 'ack') { return true; }
      if (outcome === 'timeout') {
        // Event may still land via the pool's open connections; just stop waiting.
        console.warn(`[Bridge] Publish to ${machine.hostname} timed out after ${PUBLISH_TIMEOUT_MS}ms`);
        return false;
      }

      // outcome === 'rejected' → every relay rejected. Retry once after a short backoff.
      if (attempt === 0) {
        console.warn('[Bridge] All relays rejected, retrying in 750ms...');
        await new Promise(r => setTimeout(r, 750));
      }
    } catch (err) {
      console.error(`[Bridge] Failed to publish to ${machine.hostname} (attempt ${attempt + 1}):`, err);
    }
  }
  return false;
}

function handleBridgeEvent(event: { pubkey: string; content: string; created_at: number }, _machine: RemoteMachine): void {
  if (!ownSecretKeyBytes) { return; }

  // Track latest event timestamp for `since` filter on reconnect
  const prev = lastSeenTimestamps.get(_machine.pubkeyHex) ?? 0;
  if (event.created_at > prev) {
    lastSeenTimestamps.set(_machine.pubkeyHex, event.created_at);
  }

  try {
    const conversationKey = getConversationKey(ownSecretKeyBytes, event.pubkey);
    const plaintext = decrypt(event.content, conversationKey);
    const msg: BridgeInboundMessage = JSON.parse(plaintext);

    // Successful decrypt — reset failure counter
    consecutiveDecryptFailures.set(_machine.pubkeyHex, 0);

    switch (msg.type) {
      case 'sessions':
        lastSessionListTimestamps.set(_machine.pubkeyHex, event.created_at);
        onSessionList?.({ machine: msg.machine, sessions: msg.sessions, authStatus: msg.authStatus, protocolVersion: msg.protocolVersion });
        // Fresh session list = bridge is alive
        onStatus?.(_machine.hostname, 'connected');
        break;
      case 'output':
        onOutput?.(msg.sessionId, msg.entry, msg.seq);
        break;
      case 'history':
        onHistory?.(msg.sessionId, msg.entries, msg.totalEntries, msg.chunkIndex, msg.totalChunks, msg.requestId);
        break;
      case 'session-pending':
        onSessionPending?.(msg.pendingId, msg.machine, msg.createdAt);
        break;
      case 'session-ready':
        onSessionReady?.(msg.pendingId, msg.session);
        break;
      case 'session-failed':
        onSessionFailed?.(msg.pendingId, msg.reason);
        break;
      case 'input-failed':
        onInputFailed?.(msg.sessionId, msg.reason);
        break;
      case 'close-session-ack':
        onCloseSessionAck?.(msg.sessionId, msg.success);
        break;
      case 'session-replaced':
        onSessionReplaced?.(msg.oldSessionId, msg.newSession);
        break;
      case 'mode-confirmed':
        onModeConfirmed?.(msg.sessionId, msg.mode);
        break;
      case 'effort-confirmed':
        onEffortConfirmed?.(msg.sessionId, msg.level);
        break;
      case 'model-confirmed':
        onModelConfirmed?.(msg.sessionId, msg.model);
        break;
      case 'usage':
        onUsage?.(msg.sessionId, msg.usage);
        break;
      case 'credentials-ack':
        onCredentialsAck?.(msg.machine, msg.success, msg.hasAnthropicKey, msg.hasGithubPat, msg.keyValid, msg.error);
        break;
      case 'pair-ack':
        onPairAck?.(msg.machine, msg.ok, msg.reason);
        break;
    }
  } catch (err) {
    // Track consecutive failures — if many events fail in a row, the key is likely wrong
    const prev = consecutiveDecryptFailures.get(_machine.pubkeyHex) ?? 0;
    const count = prev + 1;
    consecutiveDecryptFailures.set(_machine.pubkeyHex, count);
    console.warn(`[Bridge] Failed to decrypt/parse event (${count}/${DECRYPT_FAILURE_THRESHOLD}):`, err);
    if (count >= DECRYPT_FAILURE_THRESHOLD) {
      onStatus?.(_machine.hostname, 'disconnected');
      console.error(`[Bridge] ${count} consecutive decryption failures for ${_machine.hostname} — check Nostr keys`);
    }
  }
}

/**
 * Evaluate whether a machine's bridge is alive based on session list freshness.
 * The bridge re-publishes the session list every 60s as a heartbeat.
 */
function evaluateMachineStatus(machine: RemoteMachine): void {
  const lastTs = lastSessionListTimestamps.get(machine.pubkeyHex);
  const now = Math.floor(Date.now() / 1000);

  if (!lastTs) {
    // Never received a session list → bridge not confirmed alive
    onStatus?.(machine.hostname, 'disconnected');
    return;
  }

  const age = now - lastTs;
  if (age <= STALENESS_THRESHOLD_S) {
    onStatus?.(machine.hostname, 'connected');
  } else {
    onStatus?.(machine.hostname, 'disconnected');
  }
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}
