import { create } from 'zustand';
import type { DmConversation, DmMessage, NostrConfig, ProfileMetadata, ProfileStatus } from '../types';
import * as nostr from '../services/nostrService';
import * as profileService from '../services/profileService';
import { npubEncode } from 'nostr-tools/nip19';
import { persistGet, persistSet } from '../services/persistStore';
import { dmLog, dmWarn } from '../services/debugLog';

const DEFAULT_RELAYS = ['wss://relay2.descendant.io', 'wss://relay.primal.net', 'wss://nos.lol'];
const MAX_MESSAGES_PER_CONVERSATION = 500;
const STORAGE_KEY = 'codedeck_dm';

/** Window (seconds) within which same-content messages from the same sender are considered duplicates. */
const CONTENT_DEDUP_WINDOW_S = 60;

interface DmStore {
  conversations: DmConversation[];
  messages: Record<string, DmMessage[]>;
  activeConversationId: string | null;
  nostrConfig: NostrConfig;
  connectionStatus: 'disconnected' | 'connecting' | 'connected';
  /** Full profile metadata keyed by pubkey hex (persisted). */
  profiles: Record<string, ProfileMetadata>;
  /** Transient per-pubkey resolution status for UI (not persisted). */
  profileStatus: Record<string, ProfileStatus>;

  setActiveConversation: (id: string | null) => void;
  addMessage: (msg: DmMessage) => void;
  markConversationRead: (conversationId: string) => void;
  updateNostrConfig: (config: NostrConfig) => void;
  setConnectionStatus: (status: 'disconnected' | 'connecting' | 'connected') => void;

  connect: () => void;
  disconnect: () => void;
  sendDm: (recipientPubkey: string, content: string) => Promise<void>;
  startConversation: (recipientPubkey: string, displayName?: string) => void;
  loadPersisted: () => Promise<void>;
  resolveProfile: (pubkeyHex: string, opts?: { force?: boolean }) => Promise<void>;
  refreshProfile: (pubkeyHex: string) => Promise<void>;
  resolveAllProfiles: () => void;
}

interface PersistedDmData {
  conversations: DmConversation[];
  messages: Record<string, DmMessage[]>;
  nostrConfig: NostrConfig;
  profiles?: Record<string, ProfileMetadata>;
  /** Legacy shape (pre-outbox) — migrated to `profiles` on load. */
  profileCache?: Record<string, { name: string; fetchedAt: number }>;
}

function persist(state: { conversations: DmConversation[]; messages: Record<string, DmMessage[]>; nostrConfig: NostrConfig }) {
  const profiles = useDmStore.getState().profiles;
  persistSet(STORAGE_KEY, {
    conversations: state.conversations,
    messages: state.messages,
    nostrConfig: state.nostrConfig,
    profiles,
  });
}

/**
 * Compute the latest message timestamp across all conversations (as unix seconds).
 * Used as `since` filter when subscribing to relays so we don't replay old messages.
 * Subtracts a 30-second grace window to catch events near the boundary.
 */
function getLatestMessageTimestamp(messages: Record<string, DmMessage[]>): number | undefined {
  let latest = 0;
  for (const convMsgs of Object.values(messages)) {
    for (const msg of convMsgs) {
      const ts = Math.floor(new Date(msg.timestamp).getTime() / 1000);
      if (ts > latest) latest = ts;
    }
  }
  // NIP-59 randomizes gift-wrap created_at by up to ±2 days — use 48h grace window
  return latest > 0 ? latest - 172800 : undefined;
}

export const useDmStore = create<DmStore>((set, get) => ({
  conversations: [],
  messages: {},
  activeConversationId: null,
  nostrConfig: { private_key_hex: null, relays: DEFAULT_RELAYS },
  connectionStatus: 'disconnected',
  profiles: {},
  profileStatus: {},

  setActiveConversation: (id) => {
    set({ activeConversationId: id });
    if (id) get().markConversationRead(id);
  },

  addMessage: (msg) => {
    let newConvPubkey: string | null = null;

    set((state) => {
      const existing = state.messages[msg.conversation_id] || [];

      // Primary dedup: exact message ID match
      if (existing.some(m => m.id === msg.id)) {
        dmLog('DM Store', `ID-dedup: skipping ${msg.id.slice(0, 12)}... (already exists)`);
        return state;
      }

      // Fallback dedup: same sender + same content within time window.
      // Catches duplicates from other NIP-17 clients that generate different rumor IDs.
      const msgTs = Math.floor(new Date(msg.timestamp).getTime() / 1000);
      const isDuplicate = existing.some(m =>
        m.sender_pubkey === msg.sender_pubkey &&
        m.content === msg.content &&
        Math.abs(Math.floor(new Date(m.timestamp).getTime() / 1000) - msgTs) < CONTENT_DEDUP_WINDOW_S,
      );
      if (isDuplicate) {
        dmLog('DM Store', `Content-dedup: skipping duplicate "${msg.content.slice(0, 30)}..."`);
        return state;
      }

      // Cap messages
      const updated = existing.length >= MAX_MESSAGES_PER_CONVERSATION
        ? [...existing.slice(-(MAX_MESSAGES_PER_CONVERSATION - 1)), msg]
        : [...existing, msg];

      const newMessages = { ...state.messages, [msg.conversation_id]: updated };

      // Upsert conversation
      const convIndex = state.conversations.findIndex(c => c.id === msg.conversation_id);
      let newConversations: DmConversation[];

      if (convIndex >= 0) {
        newConversations = state.conversations.map((c, i) =>
          i === convIndex
            ? {
                ...c,
                last_message_at: msg.timestamp,
                unread_count: state.activeConversationId === c.id ? 0 : c.unread_count + 1,
              }
            : c,
        );
      } else {
        // Auto-create conversation from incoming message
        const ownPubkey = state.nostrConfig.private_key_hex
          ? nostr.getPubkeyHex(parseHexToBytes(state.nostrConfig.private_key_hex))
          : '';
        const otherPubkey = msg.sender_pubkey === ownPubkey
          ? msg.conversation_id.split(':').find(p => p !== ownPubkey) || msg.sender_pubkey
          : msg.sender_pubkey;

        newConvPubkey = otherPubkey;

        newConversations = [...state.conversations, {
          id: msg.conversation_id,
          participants: [ownPubkey, otherPubkey].filter(Boolean),
          display_name: truncatePubkey(otherPubkey),
          last_message_at: msg.timestamp,
          unread_count: state.activeConversationId === msg.conversation_id ? 0 : 1,
        }];
      }

      const newState = { conversations: newConversations, messages: newMessages };
      persist({ ...newState, nostrConfig: state.nostrConfig });
      return newState;
    });

    // Resolve profile for newly auto-created conversation
    if (newConvPubkey) {
      get().resolveProfile(newConvPubkey);
    }
  },

  markConversationRead: (conversationId) => set((state) => {
    const newConversations = state.conversations.map(c =>
      c.id === conversationId ? { ...c, unread_count: 0 } : c,
    );
    persist({ conversations: newConversations, messages: state.messages, nostrConfig: state.nostrConfig });
    return { conversations: newConversations };
  }),

  updateNostrConfig: (config) => {
    const prev = get().nostrConfig;
    set({ nostrConfig: config });
    persist({ conversations: get().conversations, messages: get().messages, nostrConfig: config });

    // Reconnect if key or relays changed
    if (prev.private_key_hex !== config.private_key_hex || JSON.stringify(prev.relays) !== JSON.stringify(config.relays)) {
      get().disconnect();
      if (config.private_key_hex) {
        get().connect();
      }
    }
  },

  setConnectionStatus: (status) => set({ connectionStatus: status }),

  connect: () => {
    const { nostrConfig, messages } = get();
    if (!nostrConfig.private_key_hex) return;

    nostr.setHandlers(
      (msg) => get().addMessage(msg),
      (status) => get().setConnectionStatus(status),
    );

    const sinceTimestamp = getLatestMessageTimestamp(messages);
    dmLog('DM Store', `Connecting — relays: ${nostrConfig.relays.join(', ')}, sinceTimestamp: ${sinceTimestamp ?? 'none'} (${sinceTimestamp ? new Date(sinceTimestamp * 1000).toISOString() : 'fetching all'})`);
    nostr.connect(nostrConfig.private_key_hex, nostrConfig.relays, sinceTimestamp);
  },

  disconnect: () => {
    nostr.disconnect();
    set({ connectionStatus: 'disconnected' });
  },

  sendDm: async (recipientPubkey, content) => {
    const { nostrConfig } = get();
    if (!nostrConfig.private_key_hex) return;

    const sk = nostrConfig.private_key_hex;
    dmLog('DM Store', `sendDm triggered — to: ${recipientPubkey.slice(0, 12)}..., relays: [${nostrConfig.relays.join(', ')}], content: ${content.length} chars`);
    try {
      const msg = await nostr.sendDirectMessage(sk, recipientPubkey, content, nostrConfig.relays);
      get().addMessage(msg);
    } catch (e) {
      dmWarn('DM Store', `Failed to send DM: ${e instanceof Error ? e.message : String(e)}`);
      // Show failed message in UI so user sees the failure
      const ownPubkey = nostr.getPubkeyHex(parseHexToBytes(sk));
      const failedMsg: DmMessage = {
        id: crypto.randomUUID(),
        conversation_id: nostr.conversationId(ownPubkey, recipientPubkey),
        sender_pubkey: ownPubkey,
        content,
        timestamp: new Date().toISOString(),
        status: 'failed',
      };
      get().addMessage(failedMsg);
    }
  },

  startConversation: (recipientPubkey, displayName) => {
    const { nostrConfig } = get();
    const ownPubkey = nostrConfig.private_key_hex
      ? nostr.getPubkeyHex(parseHexToBytes(nostrConfig.private_key_hex))
      : '0'.repeat(64);

    const convId = nostr.conversationId(ownPubkey, recipientPubkey);

    // Don't create if already exists
    if (get().conversations.some(c => c.id === convId)) {
      set({ activeConversationId: convId });
      return;
    }

    const conv: DmConversation = {
      id: convId,
      participants: [ownPubkey, recipientPubkey],
      display_name: displayName || truncatePubkey(recipientPubkey),
      last_message_at: new Date().toISOString(),
      unread_count: 0,
    };

    set((state) => ({
      conversations: [...state.conversations, conv],
      activeConversationId: convId,
      messages: state.messages[convId] ? state.messages : { ...state.messages, [convId]: [] },
    }));
    persist({ conversations: get().conversations, messages: get().messages, nostrConfig: get().nostrConfig });
    get().resolveProfile(recipientPubkey);
  },

  loadPersisted: async () => {
    try {
      const data = await persistGet<PersistedDmData>(STORAGE_KEY);
      if (!data) return;

      // Clean up legacy mock conversations (Agent Alpha/Beta placeholders)
      const mockPubkeys = new Set(['0'.repeat(64), 'a'.repeat(64), 'b'.repeat(64)]);
      const conversations = (data.conversations || []).filter(
        c => !c.participants.every(p => mockPubkeys.has(p)),
      );

      // Migrate legacy profileCache ({ name, fetchedAt }) → profiles (full metadata).
      const migrated: Record<string, ProfileMetadata> = {};
      if (data.profileCache) {
        for (const [hex, v] of Object.entries(data.profileCache)) {
          migrated[hex] = { displayName: v.name, fetchedAt: v.fetchedAt, status: 'ok' };
        }
      }
      const profiles = { ...migrated, ...(data.profiles || {}) }; // new shape wins

      set({
        conversations,
        messages: data.messages || {},
        nostrConfig: data.nostrConfig || { private_key_hex: null, relays: DEFAULT_RELAYS },
        profiles,
        profileStatus: {},
      });
    } catch { /* corrupt data — start fresh */ }
  },

  resolveProfile: async (pubkeyHex, opts) => {
    const { profiles } = get();
    const CACHE_TTL = 24 * 60 * 60 * 1000;

    // Cache hit, fresh, resolved OK, and not forced → apply and return.
    const cached = profiles[pubkeyHex];
    if (!opts?.force && cached && cached.status === 'ok' && Date.now() - cached.fetchedAt < CACHE_TTL) {
      applyProfileToConversations(pubkeyHex, cached, get, set);
      set((state) => ({ profileStatus: { ...state.profileStatus, [pubkeyHex]: 'ok' } }));
      return;
    }

    set((state) => ({ profileStatus: { ...state.profileStatus, [pubkeyHex]: 'loading' } }));

    // fetchProfileDedup collapses concurrent calls for the same pubkey.
    const meta = await profileService.fetchProfileDedup(pubkeyHex);

    if (meta.status === 'ok') {
      set((state) => ({
        profiles: { ...state.profiles, [pubkeyHex]: meta },
        profileStatus: { ...state.profileStatus, [pubkeyHex]: 'ok' },
      }));
      applyProfileToConversations(pubkeyHex, meta, get, set);
      persist({ conversations: get().conversations, messages: get().messages, nostrConfig: get().nostrConfig });
    } else {
      // notfound — cache the result (cheap retry later) but surface an error
      // state so the UI shows a tap-to-retry affordance.
      set((state) => ({
        profiles: { ...state.profiles, [pubkeyHex]: meta },
        profileStatus: { ...state.profileStatus, [pubkeyHex]: 'error' },
      }));
      persist({ conversations: get().conversations, messages: get().messages, nostrConfig: get().nostrConfig });
    }
  },

  refreshProfile: async (pubkeyHex) => {
    await get().resolveProfile(pubkeyHex, { force: true });
  },

  resolveAllProfiles: () => {
    const { conversations, nostrConfig } = get();
    if (!nostrConfig.private_key_hex) return;
    const ownPubkey = nostr.getPubkeyHex(parseHexToBytes(nostrConfig.private_key_hex));
    get().resolveProfile(ownPubkey); // own profile (for sent-bubble avatars / consistency)
    for (const conv of conversations) {
      const other = conv.participants.find(p => p !== ownPubkey);
      if (other) get().resolveProfile(other);
    }
  },
}));

// --- Helpers ---

/** Update the back-compat `display_name` label on conversations for this pubkey. */
function applyProfileToConversations(
  pubkeyHex: string,
  meta: ProfileMetadata,
  get: () => DmStore,
  set: (partial: Partial<DmStore> | ((s: DmStore) => Partial<DmStore>)) => void,
) {
  const { conversations, messages, nostrConfig } = get();
  const ownPubkey = nostrConfig.private_key_hex
    ? nostr.getPubkeyHex(parseHexToBytes(nostrConfig.private_key_hex))
    : '';

  const label = meta.displayName || meta.name;
  if (!label) return; // nothing better than the existing truncated-npub label

  let changed = false;
  const updated = conversations.map((c) => {
    const otherPubkey = c.participants.find((p) => p !== ownPubkey);
    if (otherPubkey === pubkeyHex && c.display_name !== label) {
      changed = true;
      return { ...c, display_name: label };
    }
    return c;
  });

  if (changed) {
    set({ conversations: updated });
    persist({ conversations: updated, messages, nostrConfig });
  }
}

function truncatePubkey(pubkey: string): string {
  if (pubkey.length < 16) return pubkey;
  // Convert hex pubkey to npub for display
  if (/^[0-9a-f]{64}$/i.test(pubkey)) {
    try {
      const npub = npubEncode(pubkey);
      return npub.slice(0, 10) + '...' + npub.slice(-4);
    } catch { /* fall through to raw truncation */ }
  }
  return pubkey.slice(0, 8) + '...' + pubkey.slice(-4);
}

function parseHexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}
