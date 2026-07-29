import { create } from 'zustand';
import { Session, OutputEntry, AppConfig, AgentMode, EffortLevel, TokenUsage, RemoteMachine, RemoteSessionInfo, RemoteOutputEntry, UsageData, GsdState } from '../types';
import { api, events, isTauri } from '../ipc/tauri';
import {
  initBridge,
  setBridgeHandlers,
  connectToMachine,
  disconnectFromMachine,
  reconnectAllMachines,
  sendRemoteInput,
  sendRemoteQuestionInput,
  sendRemoteImage,
  sendRemoteModeChange,
  sendRemoteKeypress,
  sendRemotePermissionResponse,
  sendHistoryRequest,
  sendCreateSessionRequest,
  sendRefreshRequest,
  sendCloseSessionRequest,
  sendRemoteEffortChange,
  sendRemoteModelChange,
  sendUsageRequest,
  sendGsdRequest,
  sendInterrupt,
  sendPairRequest,
} from '../services/bridgeService';
import { invoke } from '@tauri-apps/api/core';
import { persistGet, persistSet } from '../services/persistStore';
import { notifyIfNeeded } from '../services/notificationService';
import { DEFAULT_MODEL } from '../constants/models';
import { useDmStore } from './dmStore';
import { useUIStore } from './uiStore';

/** Everything New Session can ask the bridge for. An options object rather than positionals
 *  because the list crossed the point (test/model/cwd/create/GSD) where argument order was the
 *  only thing keeping the two call sites honest. */
export interface RemoteSessionCreateOptions {
  testSession?: boolean;
  model?: string;
  /** Project subdirectory to root the session in (CDB-033). Omitted = workspace root. */
  cwd?: string;
  /** Create + `git init` that subdirectory when it doesn't exist yet (CD-057). */
  createCwd?: boolean;
  /** Kick off the GSD workflow as soon as the session is live (CD-058). See `GsdKickoff`. */
  gsd?: GsdKickoff;
}

/**
 * "Start a new GSD project" is two things the session must do the moment it exists, in order:
 * leave plan mode (GSD's workflows *write* — in plan mode Claude Code plans instead of running
 * them), then send the command. Sequenced through `mode-confirmed` rather than fired together,
 * because a command that lands first runs its whole first turn in the wrong mode.
 */
export interface GsdKickoff {
  /** Slash command to send once the mode is confirmed, e.g. `/gsd-new-project`. */
  command: string;
  /** Mode to switch to first. 'default' = hands-free, 'acceptEdits' = still asks for commands. */
  mode: AgentMode;
}

/** A locally-created session shown instantly on "Start Session" — before the bridge
 *  round-trips a real session id back. Reconciled into the real session on session-ready. */
interface OptimisticSession {
  localId: string;
  machinePubkeyHex: string;
  createdAt: string;
  model?: string;
  effortLevel?: EffortLevel;
  testSession?: boolean;
  /** Project subdirectory the session was requested in (CDB-033); replayed on retry. */
  cwd?: string;
  /** Whether that subdirectory should be created + git init-ed if absent; replayed on retry. */
  createCwd?: boolean;
  /** Pending GSD kickoff (CD-058) — run once the real session id arrives; replayed on retry. */
  gsd?: GsdKickoff;
  /** Set once the bridge's session-pending for this create is associated with us. */
  pendingId?: string;
  /** First message(s) typed before the real session existed — flushed to the wire on adoption. */
  bufferedMessages: Array<{ text: string; image?: { base64: string; filename: string; mimeType: string } }>;
  timeoutId: ReturnType<typeof setTimeout>;
  status: 'starting' | 'failed';
}

interface SessionStore {
  sessions: Session[];
  activeSessionId: string | null;
  outputs: Record<string, OutputEntry[]>;
  config: AppConfig;
  tokenUsage: Record<string, TokenUsage>;
  unreadSessions: Set<string>;

  // Remote bridge state
  machines: RemoteMachine[];
  remoteSessions: Record<string, RemoteSessionInfo[]>; // keyed by machine pubkeyHex
  remoteSessionModes: Record<string, AgentMode>; // keyed by sessionId
  remoteSessionEffort: Record<string, EffortLevel>; // keyed by sessionId
  remoteSessionModel: Record<string, string>; // keyed by sessionId — Claude model ID
  /** Per-session in-flight mode/effort/model change awaiting a *-confirmed from the bridge.
   *  Keyed by sessionId. `prev` is the last confirmed value, restored if no confirm arrives. */
  remoteSettingPending: Record<string, { kind: 'mode' | 'effort' | 'model'; prev: AgentMode | EffortLevel | string }>;
  remoteSessionUsage: Record<string, UsageData>; // keyed by sessionId — subscription usage snapshot
  /** GSD workflow snapshot per sessionId. Absent, or `available: false`, means the session's
   *  cwd isn't a GSD project (or the bridge predates protocol v6) — the stage strip stays hidden. */
  remoteSessionGsd: Record<string, GsdState>;
  /** Sessions that have already had a GSD setup command sent (CD-058). Between sending
   *  `/gsd-new-project` and GSD writing `.planning/`, the project still looks un-set-up, so the
   *  strip would keep offering to start it — and tapping that restarts the interview from zero.
   *  Persisted alongside the opt-in so an app restart mid-interview doesn't re-arm that trap. */
  gsdStartedSessions: Record<string, boolean>;
  /** Sessions the user explicitly opted into GSD on, keyed by sessionId. Only consulted when the
   *  project has no `.planning/` yet — a real GSD project always shows the strip. Persisted, so
   *  opting in survives a restart. */
  gsdEnabledSessions: Record<string, boolean>;
  /** Latest-turn context-window occupancy in tokens, keyed by sessionId. This is a SNAPSHOT
   *  (input + cache_read + cache_creation of the most recent turn), NOT a cumulative sum — it
   *  falls after /compact. Divided by the model's max context to show a context-usage %. */
  remoteSessionContext: Record<string, number>;
  /** SDK-resolved context-window size (tokens) per session, advertised by protocol-v4+ bridges.
   *  The honest denominator for the context-usage % — reflects the real 1M-beta window when active.
   *  Absent for older bridges / before the first result, where the model-id guess is used instead. */
  remoteSessionContextWindow: Record<string, number>;
  /** Authoritative context-usage % (0–100) per session, advertised by protocol-v5+ bridges from the
   *  SDK's `query.getContextUsage()` — the same meter the Claude Code terminal shows. Preferred for
   *  display over the local tokens/window computation; absent for older bridges / before first result. */
  remoteSessionContextPercentage: Record<string, number>;
  machineProtocolVersion: Record<string, number>; // keyed by machine pubkeyHex — bridge protocol version (>=1 supports model selection)
  /** Project folders in each machine's workspace, keyed by machine pubkeyHex, as reported by a
   *  protocol-v9+ bridge. This is the New Session picker's folder list: the phone can't read the
   *  laptop's filesystem, so without it the picker could only name folders that already had a
   *  session running in them (CD-059). Empty/absent for older bridges. */
  machineFolders: Record<string, string[]>;
  historyLoading: Record<string, boolean>;
  refreshing: boolean;
  /** Pending sessions awaiting JSONL file creation. Map<pendingId, metadata>. */
  pendingSessions: Map<string, { pendingId: string; machine: string; createdAt: string; timeoutId: ReturnType<typeof setTimeout> }>;
  /** Locally-created sessions shown instantly on tap, awaiting bridge reconciliation. Map<localId, …>. */
  optimisticSessions: Map<string, OptimisticSession>;
  /** FIFO of outstanding optimistic localIds per machine pubkeyHex — drives ready/pending adoption. */
  optimisticQueueByMachine: Map<string, string[]>;
  /** Session IDs dismissed this app session — prevents reappearance from stale session-list events.
   *  Map<sessionId, dismissedAt timestamp> — entries older than 1 hour are pruned. */
  dismissedSessionIds: Map<string, number>;
  /** Tracks when sessions arrived via session-ready, for grace-period protection.
   *  Prevents onSessionList from dropping sessions whose JSONL hasn't appeared on the bridge yet.
   *  Map<sessionId, readyTimestamp> — entries are pruned after 90 seconds. */
  sessionReadyTimestamps: Map<string, number>;
  /** Undo toast state — shown briefly after deleting a remote session. */
  undoToast: { sessionId: string; label: string } | null;
  /** Transient toast shown briefly after a phone auto-pairs with a bridge. */
  pairToast: { machine: string } | null;

  setActiveSession: (id: string) => void;
  addOutput: (sessionId: string, entry: OutputEntry) => void;
  updateSession: (session: Session) => void;
  updateTokenUsage: (sessionId: string, usage: TokenUsage) => void;

  loadSessions: () => Promise<void>;
  loadConfig: () => Promise<void>;
  createSession: (name: string, group: string, repoUrl: string, branch: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  sendMessage: (sessionId: string, text: string, image?: { base64: string; filename: string; mimeType: string }) => Promise<void>;
  cancelAgent: (sessionId: string) => Promise<void>;
  respondPermission: (sessionId: string, requestId: string, allow: boolean) => Promise<void>;
  setMode: (sessionId: string, mode: AgentMode) => Promise<void>;
  setEffort: (sessionId: string, level: EffortLevel) => Promise<void>;
  setModel: (sessionId: string, model: string) => Promise<void>;
  /** Arm/re-arm the no-confirm revert timer for an in-flight setting change. */
  armSettingRevert: (sessionId: string) => void;
  /** Restore the last-confirmed mode/effort/model after a failed/unconfirmed change. */
  revertSetting: (sessionId: string) => void;
  /** Clear the in-flight marker for a session (called when a *-confirmed arrives). */
  clearSettingPending: (sessionId: string) => void;
  refreshUsage: (sessionId: string) => Promise<void>;
  refreshGsd: (sessionId: string) => Promise<void>;
  setGsdEnabled: (sessionId: string, enabled: boolean) => void;
  /** Record that a GSD setup command has gone out for this session (CD-058). */
  markGsdStarted: (sessionId: string) => void;
  setRemoteSessionModeLocal: (sessionId: string, mode: AgentMode) => void;
  updateConfig: (config: AppConfig) => Promise<void>;
  initEventListeners: () => Promise<void>;

  // Remote bridge actions
  addMachine: (machine: RemoteMachine) => void;
  /** Auto-pairing: send this phone's identity + the QR token to a freshly added machine. */
  pairWithMachine: (machine: RemoteMachine, token: string, ownNpub: string, ownPubkeyHex: string) => void;
  dismissPairToast: () => void;
  removeMachine: (pubkeyHex: string) => void;
  initBridgeService: (privateKeyHex: string) => Promise<void>;
  isRemoteSession: (sessionId: string) => boolean;
  isBridgeOffline: (sessionId: string) => boolean;
  getMachineForSession: (sessionId: string) => RemoteMachine | null;
  requestSessionHistory: (sessionId: string) => Promise<void>;
  requestRefreshSessions: () => void;
  createRemoteSession: (machine: RemoteMachine, opts?: RemoteSessionCreateOptions) => Promise<void>;
  /** Optimistic create: opens a usable session view instantly, then fires the real create. */
  startOptimisticRemoteSession: (machine: RemoteMachine, opts?: RemoteSessionCreateOptions) => void;
  /** Re-fire a create for an optimistic session that timed out or failed. */
  retryOptimisticSession: (localId: string) => void;
  deleteRemoteSession: (sessionId: string) => void;
  undoDeleteSession: () => void;
  respondRemotePermission: (sessionId: string, requestId: string, allow: boolean, modifier?: 'always' | 'never') => Promise<void>;
  sendRemoteKeypress: (sessionId: string, key: string, context?: 'plan-approval' | 'exit-plan' | 'question') => Promise<void>;
  /** Send a free-text answer to the active pending AskUserQuestion (used by multi-select "Send").
   *  Routes straight through question-input so it works regardless of the pendingQuestions flag —
   *  the bridge matches it to the most-recent unanswered question by history scan. */
  answerQuestion: (sessionId: string, text: string) => Promise<void>;
  /** Re-establish bridge subscriptions for all machines (call on foreground resume). */
  reconnectBridge: () => void;
  /** Track that a card (permission, plan approval, question) has been responded to.
   *  Map<sessionId, Set<cardId>> — structurally prevents cross-session leakage. */
  respondedCards: Map<string, Set<string>>;
  markCardResponded: (sessionId: string, cardId: string) => void;
  isCardResponded: (sessionId: string, cardId: string) => boolean;
  /** Tracks which plan approval option was selected per card (cardId → '1'|'2'|'3'). */
  planApprovalChoices: Map<string, string>;
  setPlanApprovalChoice: (cardId: string, key: string) => void;
  /** Session waiting for plan revision text input. Set when user taps "Revise plan". */
  pendingRevisionSession: string | null;
  setPendingRevision: (sessionId: string | null) => void;
  /** Tracks pending AskUserQuestion per session so InputBar can route through question-input. */
  pendingQuestions: Map<string, { optionCount: number }>;
  clearPendingQuestion: (sessionId: string) => void;
}

const defaultConfig: AppConfig = {
  anthropic_api_key: null,
  github_pat: null,
  github_username: null,
  default_mode: 'plan',
  default_effort: 'auto',
  auto_push_on_complete: true,
  notifications_enabled: true,
  workspace_base_path: '',
  max_sessions: 20,
  model: DEFAULT_MODEL,
  show_session_metadata: true,
  show_mode_badge: true,
  show_commit_badge: true,
  show_model_badge: true,
  show_usage_badge: true,
};

const CONFIG_PERSIST_KEY = 'codedeck_config';

/** Strip secret fields before persisting to localStorage / Tauri store. */
function stripSecrets(config: AppConfig): AppConfig {
  return { ...config, anthropic_api_key: null, github_pat: null };
}

/** Element-wise compare, so a value re-sent unchanged on every heartbeat isn't stored as new. */
function arraysEqual(a: string[] | undefined, b: string[]): boolean {
  return !!a && a.length === b.length && a.every((v, i) => v === b[i]);
}

// --- History chunk tracking (module-level, not in store state) ---

const HISTORY_IDLE_TIMEOUT_MS = 10_000;

let refreshTimeoutId: ReturnType<typeof setTimeout> | null = null;

/** Guard against multiple initBridgeService calls stacking handlers and intervals. */
let bridgeInitialized = false;
let staleCleanupInterval: ReturnType<typeof setInterval> | null = null;

/** Stored unlisten functions for Tauri event listeners. */
let eventUnlisteners: Array<() => void> = [];

/** Tracks sessions for which auto-history-request has already been dispatched. */
const autoHistoryRequested = new Set<string>();

/** Capped dedup set for bridgeSeq per session. Bounded to MAX_SEQ_SET_SIZE
 *  entries — when exceeded, entries below the high-water mark are pruned. */
const seenBridgeSeqs = new Map<string, Set<number>>();
const MAX_SEQ_SET_SIZE = 1000;

/** Pending delete: deferred close-session timer + snapshot for undo restoration. */
let pendingDeleteTimer: ReturnType<typeof setTimeout> | null = null;
let pendingDeleteSnapshot: {
  sessionId: string;
  machine: RemoteMachine | null;
  sessionInfo: RemoteSessionInfo | null;
  machineKey: string | null;
  outputs: OutputEntry[];
  tokenUsage: TokenUsage | null;
  mode: AgentMode | null;
  effort: EffortLevel | null;
  model: string | null;
} | null = null;

const UNDO_DELAY_MS = 4_000;

/** In-flight mode/effort/model changes: if the bridge doesn't confirm within this window we
 *  assume the round-trip failed and revert the optimistic value to its last confirmed state. */
const SETTING_CONFIRM_TIMEOUT_MS = 8_000;
const settingRevertTimers = new Map<string, ReturnType<typeof setTimeout>>();
function clearSettingRevertTimer(sessionId: string): void {
  const t = settingRevertTimers.get(sessionId);
  if (t) { clearTimeout(t); settingRevertTimers.delete(sessionId); }
}

/** Debounced persist for remote session metadata. Strips volatile fields (hasTerminal). */
let persistSessionsTimer: ReturnType<typeof setTimeout> | null = null;
let persistSessionsGetter: (() => { remoteSessions: Record<string, RemoteSessionInfo[]> }) | null = null;
function debouncedPersistRemoteSessions(getState: () => { remoteSessions: Record<string, RemoteSessionInfo[]> }): void {
  persistSessionsGetter = getState;
  if (persistSessionsTimer) clearTimeout(persistSessionsTimer);
  persistSessionsTimer = setTimeout(() => {
    persistSessionsTimer = null;
    if (!persistSessionsGetter) return;
    const sessions = persistSessionsGetter().remoteSessions;
    // Strip volatile fields before persisting
    const stripped: Record<string, RemoteSessionInfo[]> = {};
    for (const [key, list] of Object.entries(sessions)) {
      stripped[key] = list.map(({ hasTerminal: _, ...rest }) => rest);
    }
    persistSet('codedeck_remote_sessions', stripped);
  }, 2_000);
}

/** Keyed by requestId (not sessionId) — eliminates races when a second
 *  history-request is sent before the first completes. */
const historyChunkTrackers = new Map<string, {
  sessionId: string;
  totalChunks: number;
  receivedCount: number;
  timeoutId: ReturnType<typeof setTimeout>;
}>();

function clearHistoryLoading(sessionId: string, set: (fn: (state: SessionStore) => Partial<SessionStore>) => void) {
  set((state) => {
    const { [sessionId]: _, ...rest } = state.historyLoading;
    return { historyLoading: rest };
  });
}

// --- Optimistic session start helpers ---

/** If the bridge never acks an optimistic create, surface failure rather than hang on "Starting…". */
const OPTIMISTIC_NO_ACK_TIMEOUT_MS = 20_000;

type SetFn = (fn: (state: SessionStore) => Partial<SessionStore>) => void;

/** Local-only placeholder rows the bridge's session-list never contains: bridge-driven
 *  `pending:` rows and locally-created `optimistic:` rows. A session-list snapshot must
 *  never drop these before they're reconciled. */
export function isLocalPlaceholder(id: string): boolean {
  return id.startsWith('pending:') || id.startsWith('optimistic:');
}

/** Move a value from one key to another in a record (no-op if `from` is absent). */
function renameKey<T>(rec: Record<string, T>, from: string, to: string): Record<string, T> {
  if (!(from in rec)) return rec;
  const { [from]: val, ...rest } = rec;
  return { ...rest, [to]: (rest as Record<string, T>)[to] ?? val };
}

/** Rename a Set member (no-op if `from` is absent). */
function renameSetMember(s: Set<string>, from: string, to: string): Set<string> {
  if (!s.has(from)) return s;
  const next = new Set(s);
  next.delete(from);
  next.add(to);
  return next;
}

/** Arm (or re-arm) the no-ack timeout for an optimistic session. */
function armOptimisticTimeout(localId: string, set: SetFn, get: () => SessionStore): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    const opt = get().optimisticSessions.get(localId);
    if (!opt || opt.status !== 'starting') return;
    get().addOutput(`optimistic:${localId}`, {
      entry_type: 'error',
      content: 'The bridge didn’t respond. The machine may be offline — tap Retry to try again.',
      timestamp: new Date().toISOString(),
    });
    set((state) => {
      const next = new Map(state.optimisticSessions);
      const entry = next.get(localId);
      if (!entry) return {};
      next.set(localId, { ...entry, status: 'failed' });
      // Drop from the adoption queue so a stray later pending/ready can't adopt a failed one.
      const queue = new Map(state.optimisticQueueByMachine);
      queue.set(entry.machinePubkeyHex, (queue.get(entry.machinePubkeyHex) || []).filter(id => id !== localId));
      return { optimisticSessions: next, optimisticQueueByMachine: queue };
    });
  }, OPTIMISTIC_NO_ACK_TIMEOUT_MS);
}

/**
 * Sessions waiting on `mode-confirmed` before their GSD command is sent (CD-058), plus the
 * fallback timer that sends anyway. Module-level rather than store state: nothing renders it,
 * and a timer handle has no business being persisted.
 */
const pendingGsdKickoffs = new Map<string, { command: string; timerId: ReturnType<typeof setTimeout> }>();

/** How long to wait for `mode-confirmed` before sending the GSD command regardless. A bridge that
 *  never confirms (older, or the control request failed) must not silently swallow the whole
 *  feature — a wrong-mode run is recoverable, a run that never happens looks exactly like the bug
 *  this replaces. */
const GSD_KICKOFF_FALLBACK_MS = 6_000;

/** Test seam + teardown: drop any armed kickoff without firing it. */
export function cancelGsdKickoff(sessionId: string): void {
  const pending = pendingGsdKickoffs.get(sessionId);
  if (!pending) return;
  clearTimeout(pending.timerId);
  pendingGsdKickoffs.delete(sessionId);
}

/** Send an armed GSD command now (mode confirmed, or the fallback fired). No-op if none armed. */
export function fireGsdKickoff(sessionId: string, get: () => SessionStore): void {
  const pending = pendingGsdKickoffs.get(sessionId);
  if (!pending) return;
  clearTimeout(pending.timerId);
  pendingGsdKickoffs.delete(sessionId);
  void get().sendMessage(sessionId, pending.command);
}

/**
 * Start the GSD workflow on a freshly adopted session: opt the stage strip in, switch out of plan
 * mode, and arm the command to go out as soon as that mode change is confirmed.
 */
export function startGsdKickoff(sessionId: string, kickoff: GsdKickoff, get: () => SessionStore): void {
  // Opt the strip in immediately: this session is a GSD project by construction, and without this
  // the strip stays hidden until `.planning/` exists — i.e. for the entire interview.
  get().setGsdEnabled(sessionId, true);

  get().markGsdStarted(sessionId);

  cancelGsdKickoff(sessionId);
  const timerId = setTimeout(() => fireGsdKickoff(sessionId, get), GSD_KICKOFF_FALLBACK_MS);
  pendingGsdKickoffs.set(sessionId, { command: kickoff.command, timerId });

  // If the session is already in the target mode the bridge has nothing to confirm, so don't wait.
  if ((get().remoteSessionModes[sessionId] ?? 'plan') === kickoff.mode) {
    fireGsdKickoff(sessionId, get);
    return;
  }
  void get().setMode(sessionId, kickoff.mode);
}

/** Reconcile a locally-created optimistic session into the real bridge session.
 *  Rewrites the row in place (no flicker), migrates per-session maps, moves the active
 *  selection, clears optimistic bookkeeping, and flushes any buffered first message. */
export function adoptOptimisticSession(localId: string, session: RemoteSessionInfo, set: SetFn, get: () => SessionStore): void {
  const rowId = `optimistic:${localId}`;
  const opt = get().optimisticSessions.get(localId);
  if (opt) clearTimeout(opt.timeoutId);

  set((state) => {
    const newRemoteSessions = { ...state.remoteSessions };
    let machineKey: string | undefined;
    for (const [pubkeyHex, sessions] of Object.entries(newRemoteSessions)) {
      const idx = sessions.findIndex(s => s.id === rowId);
      if (idx >= 0) {
        machineKey = pubkeyHex;
        const updated = [...sessions];
        // Rewrite in place at the same index — preserve the user's first-message title
        // over the bridge's null (mirrors the session-list merge at ~line 919).
        updated[idx] = { ...sessions[idx], ...session, title: session.title ?? sessions[idx].title };
        // Dedup: drop any other row that already carries the real id.
        newRemoteSessions[pubkeyHex] = updated.filter((s, i) => i === idx || s.id !== session.id);
        break;
      }
    }
    // Optimistic row vanished (shouldn't happen) — insert the real session under its machine.
    if (!machineKey && opt) {
      machineKey = opt.machinePubkeyHex;
      const existing = newRemoteSessions[machineKey] || [];
      if (!existing.some(s => s.id === session.id)) {
        newRemoteSessions[machineKey] = [...existing, session];
      }
    }

    // Migrate per-session keyed state from the optimistic row id to the real id.
    const remoteSessionEffort = renameKey(state.remoteSessionEffort, rowId, session.id);
    const remoteSessionModel = renameKey(state.remoteSessionModel, rowId, session.id);
    const remoteSessionContextWindow = renameKey(state.remoteSessionContextWindow, rowId, session.id);
    const remoteSessionContextPercentage = renameKey(state.remoteSessionContextPercentage, rowId, session.id);
    if (session.effortLevel && !remoteSessionEffort[session.id]) remoteSessionEffort[session.id] = session.effortLevel;
    if (session.model && !remoteSessionModel[session.id]) remoteSessionModel[session.id] = session.model;
    if (session.contextWindow && !remoteSessionContextWindow[session.id]) remoteSessionContextWindow[session.id] = session.contextWindow;
    // percentage can legitimately be 0, so guard on undefined, not falsiness
    if (typeof session.contextPercentage === 'number' && remoteSessionContextPercentage[session.id] === undefined) remoteSessionContextPercentage[session.id] = session.contextPercentage;

    const readyTs = new Map(state.sessionReadyTimestamps);
    readyTs.set(session.id, Date.now());

    const optimisticSessions = new Map(state.optimisticSessions);
    optimisticSessions.delete(localId);
    const optimisticQueueByMachine = new Map(state.optimisticQueueByMachine);
    if (machineKey) {
      optimisticQueueByMachine.set(machineKey, (optimisticQueueByMachine.get(machineKey) || []).filter(id => id !== localId));
    } else {
      for (const [k, list] of optimisticQueueByMachine) {
        if (list.includes(localId)) optimisticQueueByMachine.set(k, list.filter(id => id !== localId));
      }
    }

    return {
      remoteSessions: newRemoteSessions,
      outputs: renameKey(state.outputs, rowId, session.id),
      remoteSessionModes: renameKey(state.remoteSessionModes, rowId, session.id),
      remoteSessionContext: renameKey(state.remoteSessionContext, rowId, session.id),
      remoteSessionEffort,
      remoteSessionModel,
      remoteSessionContextWindow,
      remoteSessionContextPercentage,
      unreadSessions: renameSetMember(state.unreadSessions, rowId, session.id),
      sessionReadyTimestamps: readyTs,
      optimisticSessions,
      optimisticQueueByMachine,
      activeSessionId: state.activeSessionId === rowId ? session.id : state.activeSessionId,
    };
  });
  debouncedPersistRemoteSessions(get);

  // "New GSD project" (CD-058): the session only just acquired a real id, which is the first
  // moment mode changes and input can be addressed to it. Runs before the buffered flush so the
  // mode switch is on the wire ahead of anything the user typed while it was starting.
  if (opt?.gsd) startGsdKickoff(session.id, opt.gsd, get);

  // Flush any message the user typed before the real session existed.
  if (opt && opt.bufferedMessages.length > 0) {
    const machine = get().machines.find(m => m.pubkeyHex === opt.machinePubkeyHex);
    if (machine) {
      const blossomServer = useDmStore.getState().nostrConfig.blossomServer;
      for (const buffered of opt.bufferedMessages) {
        const send = buffered.image
          ? sendRemoteImage(machine, session.id, buffered.text, buffered.image.base64, buffered.image.filename, buffered.image.mimeType, blossomServer)
          : sendRemoteInput(machine, session.id, buffered.text);
        Promise.resolve(send).catch((e) => {
          get().addOutput(session.id, {
            entry_type: 'error',
            content: `Failed to send queued message: ${e}`,
            timestamp: new Date().toISOString(),
          });
        });
      }
    }
  }
}

/** Binary search for insertion index by bridgeSeq. */
function findInsertIndex(entries: OutputEntry[], seq: number): number {
  let lo = 0, hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const midSeq = (entries[mid].metadata?.bridgeSeq as number) ?? 0;
    if (midSeq < seq) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Sort outputs array by bridgeSeq so out-of-order chunks render correctly. */
function sortOutputsBySeq(sessionId: string, set: (fn: (state: SessionStore) => Partial<SessionStore>) => void) {
  set((state) => {
    const outputs = state.outputs[sessionId];
    if (!outputs || outputs.length === 0) return state;
    const sorted = [...outputs].sort((a, b) => {
      const seqA = (a.metadata?.bridgeSeq as number) ?? 0;
      const seqB = (b.metadata?.bridgeSeq as number) ?? 0;
      return seqA - seqB;
    });
    return { outputs: { ...state.outputs, [sessionId]: sorted } };
  });
}

// --- Mock agent simulation ---
function mockAgentResponse(sessionId: string, text: string, get: () => SessionStore) {
  const add = (entry: OutputEntry) => get().addOutput(sessionId, entry);
  const now = () => new Date().toISOString();

  // Update session to running
  const session = get().sessions.find(s => s.id === sessionId);
  if (session) {
    get().updateSession({ ...session, state: 'running' });
  }

  const steps: { delay: number; fn: () => void }[] = [
    { delay: 300, fn: () => add({ entry_type: 'action', content: 'List: .', timestamp: now(), metadata: { tool_type: 'list_dir' } }) },
    { delay: 600, fn: () => add({ entry_type: 'action', content: 'list_dir: 12 entries', timestamp: now(), metadata: { tool_type: 'list_dir' } }) },
    { delay: 900, fn: () => add({ entry_type: 'message', content: `I see you asked: "${text}"\n\n`, timestamp: now(), metadata: { streaming: true } }) },
    { delay: 1000, fn: () => add({ entry_type: 'message', content: 'Let me explore the workspace ', timestamp: now(), metadata: { streaming: true } }) },
    { delay: 1100, fn: () => add({ entry_type: 'message', content: 'to understand what we have here.\n\n', timestamp: now(), metadata: { streaming: true } }) },
    { delay: 1300, fn: () => add({ entry_type: 'action', content: 'Read: src/main.rs', timestamp: now(), metadata: { tool_type: 'file_read' } }) },
    { delay: 1600, fn: () => add({ entry_type: 'action', content: 'file_read: 245 chars output', timestamp: now(), metadata: { tool_type: 'file_read' } }) },
    { delay: 1900, fn: () => add({ entry_type: 'message', content: 'I found the main entry point. ', timestamp: now(), metadata: { streaming: true } }) },
    { delay: 2100, fn: () => add({ entry_type: 'message', content: 'This is a mock response — connect your Anthropic API key in **Settings** to enable real agent interactions.\n\n', timestamp: now(), metadata: { streaming: true } }) },
    { delay: 2300, fn: () => add({ entry_type: 'message', content: 'In mock mode, you can test the full UI: create sessions, switch between them, try PLAN mode permissions, and explore the layout.', timestamp: now(), metadata: { streaming: true } }) },
    { delay: 2500, fn: () => add({ entry_type: 'system', content: '', timestamp: now(), metadata: { stream_end: true } }) },
    { delay: 2600, fn: () => {
      if (session) {
        get().updateSession({ ...session, state: 'completed' });
        get().updateTokenUsage(sessionId, { input_tokens: 1250, output_tokens: 340, total_cost_usd: 0.0089 });
      }
    }},
  ];

  // If in plan mode, insert a mock permission request
  if (session?.mode === 'plan') {
    steps.splice(3, 0, {
      delay: 800,
      fn: () => {
        if (session) {
          const perm = {
            id: crypto.randomUUID(),
            tool_type: 'bash_exec',
            description: 'List project files',
            command: 'ls -la src/',
            timestamp: now(),
          };
          get().updateSession({
            ...session,
            state: 'waiting_permission',
            pending_permissions: [perm],
          });
        }
      },
    });
  }

  steps.forEach(({ delay, fn }) => setTimeout(fn, delay));
}

/** True when the app is foreground/visible. Falls back to true outside a DOM (tests). */
function isAppVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

/** Add sessionId to unreadSessions if not already marked. */
function markUnread(state: SessionStore, sessionId: string): Partial<SessionStore> {
  if (state.unreadSessions.has(sessionId)) return {};
  return { unreadSessions: new Set([...state.unreadSessions, sessionId]) };
}

/** Remove sessionId from unreadSessions (called when the user actually responds). */
function clearUnread(state: SessionStore, sessionId: string): Partial<SessionStore> {
  if (!state.unreadSessions.has(sessionId)) return {};
  const unreadSessions = new Set(state.unreadSessions);
  unreadSessions.delete(sessionId);
  return { unreadSessions };
}

/** Returns true when the entry represents an interactive prompt requiring user action. */
function needsUserInput(entry: OutputEntry): boolean {
  const special = entry.metadata?.special as string | undefined;
  return special === 'plan_approval' || special === 'ask_question' || special === 'permission_request';
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  outputs: {},
  config: defaultConfig,
  tokenUsage: {},
  unreadSessions: new Set(),
  machines: [],
  remoteSessions: {},
  remoteSessionModes: {},
  remoteSessionEffort: {},
  remoteSessionModel: {},
  remoteSettingPending: {},
  remoteSessionUsage: {},
  remoteSessionGsd: {},
  gsdEnabledSessions: {},
  gsdStartedSessions: {},
  remoteSessionContext: {},
  remoteSessionContextWindow: {},
  remoteSessionContextPercentage: {},
  machineProtocolVersion: {},
  machineFolders: {},
  historyLoading: {},
  refreshing: false,
  pendingSessions: new Map(),
  optimisticSessions: new Map(),
  optimisticQueueByMachine: new Map(),
  dismissedSessionIds: new Map(),
  sessionReadyTimestamps: new Map(),
  undoToast: null,
  pairToast: null,
  respondedCards: new Map(),
  planApprovalChoices: new Map(),
  pendingRevisionSession: null,
  pendingQuestions: new Map(),

  clearPendingQuestion: (sessionId) => set((state) => {
    if (!state.pendingQuestions.has(sessionId)) return state;
    const next = new Map(state.pendingQuestions);
    next.delete(sessionId);
    return { pendingQuestions: next };
  }),

  markCardResponded: (sessionId, cardId) => set((state) => {
    const existing = state.respondedCards.get(sessionId);
    if (existing?.has(cardId)) return state;
    const next = new Map(state.respondedCards);
    const sessionSet = new Set(existing);
    sessionSet.add(cardId);
    next.set(sessionId, sessionSet);
    return { respondedCards: next };
  }),

  isCardResponded: (sessionId, cardId) => {
    return get().respondedCards.get(sessionId)?.has(cardId) ?? false;
  },

  setPlanApprovalChoice: (cardId, key) => set((state) => {
    const next = new Map(state.planApprovalChoices);
    next.set(cardId, key);
    return { planApprovalChoices: next };
  }),

  setPendingRevision: (sessionId) => set({ pendingRevisionSession: sessionId }),

  // Opening/viewing a session clears its unread dot (when the app is foreground).
  setActiveSession: (id) => set((state) => ({
    activeSessionId: id,
    ...(id && isAppVisible() ? clearUnread(state, id) : {}),
  })),

  addOutput: (sessionId, entry) => set((state) => {
    const existing = state.outputs[sessionId] || [];
    // Don't light the unread dot for the session the user is foreground-watching, or
    // while we're replaying history into it.
    const skipMark = (isAppVisible() && state.activeSessionId === sessionId) || !!state.historyLoading[sessionId];

    // Streaming: append to last message entry
    if (entry.metadata?.streaming && existing.length > 0) {
      const last = existing[existing.length - 1];
      if (last.entry_type === 'message') {
        const updated = [...existing];
        updated[updated.length - 1] = {
          ...last,
          content: last.content + entry.content,
        };
        // A card entry (permission/plan/question) marks the session as blocked; any other
        // output means the agent is actively working, so clear the dot (it's not waiting on us).
        // The "task fully done" mark is handled by the stream_end branch above.
        return { outputs: { ...state.outputs, [sessionId]: updated }, ...(needsUserInput(entry) ? (skipMark ? {} : markUnread(state, sessionId)) : clearUnread(state, sessionId)) };
      }
    }

    // Stream end marker — don't create an entry, but mark session as needing attention
    if (entry.metadata?.stream_end) {
      return { ...state, ...(skipMark ? {} : markUnread(state, sessionId)) };
    }

    // Accumulate token usage directly in the store (don't mark unread for metrics)
    if (entry.entry_type === 'token_usage') {
      // Prefer structured metadata.usage (reliable) over regex on content string (fragile).
      // The cache fields are the standard Anthropic usage shape forwarded verbatim by the bridge.
      const usage = entry.metadata?.usage as {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
      } | undefined;
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;

      if (usage && typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number') {
        inputTokens = usage.input_tokens;
        outputTokens = usage.output_tokens;
      } else {
        // Fallback: parse from content string for backward compatibility
        const match = entry.content.match(/Tokens:\s*(\d+)\s*in\s*\/\s*(\d+)\s*out/);
        if (match) {
          inputTokens = parseInt(match[1], 10);
          outputTokens = parseInt(match[2], 10);
        }
      }

      if (inputTokens !== undefined && outputTokens !== undefined) {
        const prev = state.tokenUsage[sessionId] || { input_tokens: 0, output_tokens: 0, total_cost_usd: 0 };
        // Context-window occupancy is a per-turn SNAPSHOT, not a cumulative sum: the total input
        // for this turn = input + cache_read + cache_creation (per the Anthropic usage spec). The
        // latest turn wins; it falls naturally after /compact. Only available from structured
        // metadata (the content-string fallback has no cache breakdown), so leave the prior
        // snapshot untouched when we couldn't read it.
        const cacheRead = typeof usage?.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0;
        const cacheCreate = typeof usage?.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0;
        const contextTokens = usage && typeof usage.input_tokens === 'number'
          ? usage.input_tokens + cacheRead + cacheCreate
          : undefined;
        return {
          outputs: { ...state.outputs, [sessionId]: existing },
          tokenUsage: {
            ...state.tokenUsage,
            [sessionId]: {
              input_tokens: prev.input_tokens + inputTokens,
              output_tokens: prev.output_tokens + outputTokens,
              total_cost_usd: prev.total_cost_usd,
            },
          },
          ...(contextTokens !== undefined
            ? { remoteSessionContext: { ...state.remoteSessionContext, [sessionId]: contextTokens } }
            : {}),
        };
      }
      return state;
    }

    // Normal entry — insert at correct position by bridgeSeq (handles
    // Nostr relay delivering stored events newest-first on reconnect)
    const seq = entry.metadata?.bridgeSeq as number | undefined;
    let updated: OutputEntry[];

    if (seq !== undefined) {
      // Dedup via capped Set (bounded to MAX_SEQ_SET_SIZE entries)
      let seen = seenBridgeSeqs.get(sessionId);
      if (!seen) { seen = new Set(); seenBridgeSeqs.set(sessionId, seen); }
      if (seen.has(seq)) { return state; }
      seen.add(seq);
      // Prune: drop entries below (max - MAX_SEQ_SET_SIZE) when set grows too large
      if (seen.size > MAX_SEQ_SET_SIZE) {
        let maxSeq = 0;
        for (const s of seen) { if (s > maxSeq) maxSeq = s; }
        const cutoff = maxSeq - MAX_SEQ_SET_SIZE;
        for (const s of seen) { if (s <= cutoff) seen.delete(s); }
      }

      const insertIdx = findInsertIndex(existing, seq);
      updated = [...existing.slice(0, insertIdx), entry, ...existing.slice(insertIdx)];
    } else {
      updated = [...existing, entry];
    }

    if (updated.length > 5000) {
      updated = updated.slice(-5000);
    }
    // A card entry (permission/plan/question) marks the session as blocked; any other
    // output means the agent is actively working, so clear the dot (it's not waiting on us).
    // The "task fully done" mark is handled by the stream_end branch above.
    return { outputs: { ...state.outputs, [sessionId]: updated }, ...(needsUserInput(entry) ? (skipMark ? {} : markUnread(state, sessionId)) : clearUnread(state, sessionId)) };
  }),

  updateSession: (session) => set((state) => ({
    sessions: state.sessions.map((s) => s.id === session.id ? session : s),
  })),

  updateTokenUsage: (sessionId, usage) => set((state) => ({
    tokenUsage: { ...state.tokenUsage, [sessionId]: usage },
  })),

  loadSessions: async () => {
    const sessions = await api.getSessions();
    if (sessions) set({ sessions });
  },

  loadConfig: async () => {
    const config = await api.getConfig();
    if (config) {
      set({ config });
      return;
    }
    // Browser-mode fallback: restore non-secret fields from persistStore.
    const saved = await persistGet<AppConfig>(CONFIG_PERSIST_KEY);
    if (saved) {
      set({
        config: {
          ...defaultConfig,
          ...saved,
          anthropic_api_key: null,
          github_pat: null,
        },
      });
    }
  },

  createSession: async (name, group, repoUrl, branch) => {
    if (!isTauri()) {
      const mockSession: Session = {
        id: crypto.randomUUID(),
        name,
        group,
        repo_url: repoUrl,
        branch,
        workspace_path: `/workspace/${name}`,
        state: 'idle',
        mode: get().config.default_mode,
        created_at: new Date().toISOString(),
        last_activity: new Date().toISOString(),
        pending_permissions: [],
        git_sync_status: 'never_pushed',
        token_usage: { input_tokens: 0, output_tokens: 0, total_cost_usd: 0 },
        workspace_ready: true,
      };
      set((state) => ({ sessions: [...state.sessions, mockSession], activeSessionId: mockSession.id }));
      return;
    }
    const session = await api.createSession(name, group, repoUrl, branch);
    if (session) {
      set((state) => ({ sessions: [...state.sessions, session], activeSessionId: session.id }));
    }
  },

  deleteSession: async (id) => {
    if (isTauri()) await api.deleteSession(id);
    set((state) => ({
      sessions: state.sessions.filter((s) => s.id !== id),
      activeSessionId: state.activeSessionId === id ? null : state.activeSessionId,
    }));
  },

  sendMessage: async (sessionId, text, image) => {
    // Optimistic session: the bridge doesn't know this id yet. Echo locally and buffer
    // the message — it's flushed to the wire when session-ready adopts the row.
    if (sessionId.startsWith('optimistic:')) {
      const localId = sessionId.slice('optimistic:'.length);
      const opt = get().optimisticSessions.get(localId);
      if (opt) {
        set((state) => clearUnread(state, sessionId));
        get().addOutput(sessionId, {
          entry_type: 'user_message',
          content: text || (image ? `[Image: ${image.filename}]` : ''),
          timestamp: new Date().toISOString(),
          ...(image ? { metadata: { imageFilename: image.filename } } : {}),
        });
        if (text) {
          set((state) => {
            const sessions = state.remoteSessions[opt.machinePubkeyHex] || [];
            const idx = sessions.findIndex(s => s.id === sessionId);
            if (idx !== -1 && !sessions[idx].title) {
              const title = text.replace(/\n/g, ' ').trim();
              const updated = [...sessions];
              updated[idx] = { ...updated[idx], title: title.length > 80 ? title.slice(0, 77) + '...' : title };
              return { remoteSessions: { ...state.remoteSessions, [opt.machinePubkeyHex]: updated } };
            }
            return {};
          });
        }
        set((state) => {
          const next = new Map(state.optimisticSessions);
          const entry = next.get(localId);
          if (entry) next.set(localId, { ...entry, bufferedMessages: [...entry.bufferedMessages, { text, image }] });
          return { optimisticSessions: next };
        });
        return;
      }
      // No optimistic entry (already adopted/cleaned) — fall through to the normal path.
    }

    set((state) => clearUnread(state, sessionId));
    get().addOutput(sessionId, {
      entry_type: 'user_message',
      content: text || (image ? `[Image: ${image.filename}]` : ''),
      timestamp: new Date().toISOString(),
      ...(image ? { metadata: { imageFilename: image.filename } } : {}),
    });

    // Set title from first message if session still has a hex slug or no title
    if (text) {
      set((state) => {
        for (const [key, sessions] of Object.entries(state.remoteSessions)) {
          const idx = sessions.findIndex(s => s.id === sessionId);
          if (idx !== -1 && !sessions[idx].title) {
            const title = text.replace(/\n/g, ' ').trim();
            const updated = [...sessions];
            updated[idx] = { ...updated[idx], title: title.length > 80 ? title.slice(0, 77) + '...' : title };
            return { remoteSessions: { ...state.remoteSessions, [key]: updated } };
          }
        }
        return {};
      });
    }

    // Check if this is a remote session
    const machine = get().getMachineForSession(sessionId);
    if (machine) {
      try {
        if (image) {
          const blossomServer = useDmStore.getState().nostrConfig.blossomServer;
          await sendRemoteImage(machine, sessionId, text, image.base64, image.filename, image.mimeType, blossomServer);
        } else {
          // If a question menu is pending, route as question-input so the bridge
          // can set parent_tool_use_id and route the answer to the correct AskUserQuestion.
          const pending = get().pendingQuestions.get(sessionId);
          if (pending) {
            get().clearPendingQuestion(sessionId);
            await sendRemoteQuestionInput(machine, sessionId, text, pending.optionCount);
          } else {
            await sendRemoteInput(machine, sessionId, text);
          }
        }
      } catch (e) {
        get().addOutput(sessionId, {
          entry_type: 'error',
          content: `Remote error: ${e}`,
          timestamp: new Date().toISOString(),
        });
      }
      return;
    }

    if (!isTauri()) {
      mockAgentResponse(sessionId, text || '[Image attached]', get);
      return;
    }
    try {
      await api.sendMessage(sessionId, text);
    } catch (e) {
      get().addOutput(sessionId, {
        entry_type: 'error',
        content: `Error: ${e}`,
        timestamp: new Date().toISOString(),
      });
    }
  },

  cancelAgent: async (sessionId) => {
    // Remote session: send interrupt message to bridge
    const machine = get().getMachineForSession(sessionId);
    if (machine) {
      try {
        await sendInterrupt(machine, sessionId);
      } catch (e) {
        get().addOutput(sessionId, {
          entry_type: 'error',
          content: `Interrupt failed: ${e}`,
          timestamp: new Date().toISOString(),
        });
      }
      return;
    }

    if (!isTauri()) {
      // Mock: just set to completed
      const session = get().sessions.find(s => s.id === sessionId);
      if (session) {
        get().updateSession({ ...session, state: 'completed', pending_permissions: [] });
        get().addOutput(sessionId, {
          entry_type: 'system',
          content: 'Agent cancelled.',
          timestamp: new Date().toISOString(),
        });
      }
      return;
    }
    try {
      await api.cancelAgent(sessionId);
    } catch (e) {
      get().addOutput(sessionId, {
        entry_type: 'error',
        content: `Cancel failed: ${e}`,
        timestamp: new Date().toISOString(),
      });
    }
  },

  respondPermission: async (sessionId, requestId, allow) => {
    set((state) => clearUnread(state, sessionId));
    if (!isTauri()) {
      // Mock: remove permission and resume
      const session = get().sessions.find(s => s.id === sessionId);
      if (session) {
        get().updateSession({
          ...session,
          state: 'running',
          pending_permissions: session.pending_permissions.filter(p => p.id !== requestId),
        });
        if (allow) {
          get().addOutput(sessionId, {
            entry_type: 'action',
            content: 'bash_exec: `ls -la src/`',
            timestamp: new Date().toISOString(),
            metadata: { tool_type: 'bash_exec' },
          });
        } else {
          get().addOutput(sessionId, {
            entry_type: 'system',
            content: 'Denied: bash_exec',
            timestamp: new Date().toISOString(),
          });
        }
        // Continue mock flow
        setTimeout(() => {
          get().updateSession({ ...session, state: 'completed', pending_permissions: [] });
        }, 500);
      }
      return;
    }
    await api.respondPermission(sessionId, requestId, allow);
  },

  setMode: async (sessionId, mode) => {
    // Check if this is a remote session
    const machine = get().getMachineForSession(sessionId);
    if (machine) {
      // Optimistic update + mark in-flight, remembering the prior value to revert to.
      const prev = get().remoteSessionModes[sessionId] ?? 'plan';
      set((state) => ({
        remoteSessionModes: { ...state.remoteSessionModes, [sessionId]: mode },
        remoteSettingPending: { ...state.remoteSettingPending, [sessionId]: { kind: 'mode', prev } },
      }));
      get().armSettingRevert(sessionId);
      try {
        await sendRemoteModeChange(machine, sessionId, mode);
      } catch (e) {
        console.error('[SessionStore] Failed to send remote mode change:', e);
        get().revertSetting(sessionId); // send itself failed — restore immediately
      }
      return;
    }

    // Local session
    set((state) => ({
      sessions: state.sessions.map((s) => s.id === sessionId ? { ...s, mode } : s),
    }));
    if (isTauri()) await api.setMode(sessionId, mode);
  },

  setEffort: async (sessionId, level) => {
    const machine = get().getMachineForSession(sessionId);
    if (machine) {
      const prev = get().remoteSessionEffort[sessionId] ?? 'auto';
      set((state) => ({
        remoteSessionEffort: { ...state.remoteSessionEffort, [sessionId]: level },
        remoteSettingPending: { ...state.remoteSettingPending, [sessionId]: { kind: 'effort', prev } },
      }));
      get().armSettingRevert(sessionId);
      try {
        await sendRemoteEffortChange(machine, sessionId, level);
      } catch (e) {
        console.error('[SessionStore] Failed to send remote effort change:', e);
        get().revertSetting(sessionId);
      }
    }
  },

  setModel: async (sessionId, model) => {
    const machine = get().getMachineForSession(sessionId);
    if (machine) {
      const prev = get().remoteSessionModel[sessionId] ?? '';
      set((state) => ({
        remoteSessionModel: { ...state.remoteSessionModel, [sessionId]: model },
        remoteSettingPending: { ...state.remoteSettingPending, [sessionId]: { kind: 'model', prev } },
      }));
      get().armSettingRevert(sessionId);
      try {
        await sendRemoteModelChange(machine, sessionId, model);
      } catch (e) {
        console.error('[SessionStore] Failed to send remote model change:', e);
        get().revertSetting(sessionId);
      }
    }
  },

  /** Arm (or re-arm) the revert timer for an in-flight setting change on this session. */
  armSettingRevert: (sessionId) => {
    clearSettingRevertTimer(sessionId);
    settingRevertTimers.set(sessionId, setTimeout(() => {
      settingRevertTimers.delete(sessionId);
      get().revertSetting(sessionId);
    }, SETTING_CONFIRM_TIMEOUT_MS));
  },

  /** Restore the last-confirmed value for a session whose change never got confirmed. */
  revertSetting: (sessionId) => {
    clearSettingRevertTimer(sessionId);
    const pending = get().remoteSettingPending[sessionId];
    if (!pending) return;
    set((state) => {
      const { [sessionId]: _drop, ...restPending } = state.remoteSettingPending;
      const next: Partial<SessionStore> = { remoteSettingPending: restPending };
      if (pending.kind === 'mode') {
        next.remoteSessionModes = { ...state.remoteSessionModes, [sessionId]: pending.prev as AgentMode };
      } else if (pending.kind === 'effort') {
        next.remoteSessionEffort = { ...state.remoteSessionEffort, [sessionId]: pending.prev as EffortLevel };
      } else {
        next.remoteSessionModel = { ...state.remoteSessionModel, [sessionId]: pending.prev as string };
      }
      return next as SessionStore;
    });
  },

  /** Clear the in-flight marker once the bridge confirms a change (called by *-confirmed handlers). */
  clearSettingPending: (sessionId) => {
    clearSettingRevertTimer(sessionId);
    if (!get().remoteSettingPending[sessionId]) return;
    set((state) => {
      const { [sessionId]: _drop, ...restPending } = state.remoteSettingPending;
      return { remoteSettingPending: restPending };
    });
  },

  refreshUsage: async (sessionId) => {
    const machine = get().getMachineForSession(sessionId);
    if (!machine) { return; }
    try {
      await sendUsageRequest(machine, sessionId);
    } catch (e) {
      console.error('[SessionStore] Failed to send usage request:', e);
    }
  },

  refreshGsd: async (sessionId) => {
    const machine = get().getMachineForSession(sessionId);
    if (!machine) { return; }
    try {
      await sendGsdRequest(machine, sessionId);
    } catch (e) {
      console.error('[SessionStore] Failed to send GSD request:', e);
    }
  },

  setGsdEnabled: (sessionId, enabled) => {
    set((state) => ({
      gsdEnabledSessions: { ...state.gsdEnabledSessions, [sessionId]: enabled },
    }));
    void persistSet('codedeck_gsd_enabled', { ...get().gsdEnabledSessions });
    // Opting in is the moment the user wants to see something, so fetch rather than wait for
    // the next turn boundary.
    if (enabled) void get().refreshGsd(sessionId);
  },

  markGsdStarted: (sessionId) => {
    if (get().gsdStartedSessions[sessionId]) return;
    set((state) => ({
      gsdStartedSessions: { ...state.gsdStartedSessions, [sessionId]: true },
    }));
    void persistSet('codedeck_gsd_started', { ...get().gsdStartedSessions });
  },

  setRemoteSessionModeLocal: (sessionId, mode) => {
    set((state) => ({
      remoteSessionModes: { ...state.remoteSessionModes, [sessionId]: mode },
    }));
  },

  updateConfig: async (config) => {
    set({ config });
    if (isTauri()) await api.updateConfig(config);
    persistSet(CONFIG_PERSIST_KEY, stripSecrets(config));
  },

  initEventListeners: async () => {
    // Clean up previous listeners to prevent duplicates on re-init
    for (const unlisten of eventUnlisteners) { unlisten(); }
    eventUnlisteners = [];

    const u1 = await events.onSessionOutput((data) => {
      const { session_id, entry } = data as { session_id: string; entry: OutputEntry };
      get().addOutput(session_id, entry);
    });
    const u2 = await events.onSessionState((data) => {
      const { session } = data as { session_id: string; session: Session };
      get().updateSession(session);
    });
    const u3 = await events.onPermissionRequest(() => {
      get().loadSessions();
    });
    const u4 = await events.onTokenUsage((data) => {
      const { session_id, usage } = data as { session_id: string; usage: TokenUsage };
      get().updateTokenUsage(session_id, usage);
    });
    eventUnlisteners = [u1, u2, u3, u4];
  },

  // --- Remote Bridge ---

  addMachine: (machine) => {
    set((state) => {
      const idx = state.machines.findIndex(m => m.pubkeyHex === machine.pubkeyHex);
      if (idx >= 0) {
        // Upsert: update hostname/relays for existing machine
        const updated = [...state.machines];
        updated[idx] = { ...updated[idx], hostname: machine.hostname, relays: machine.relays };
        return { machines: updated };
      }
      return { machines: [...state.machines, machine] };
    });
    connectToMachine(machine);
    persistSet('codedeck_machines', get().machines);
  },

  pairWithMachine: (machine, token, ownNpub, ownPubkeyHex) => {
    // Fire the pairing request; the bridge's open pairing window will accept it
    // (token-gated) and reply with a pair-ack that flips the machine to connected.
    sendPairRequest(machine, ownNpub, ownPubkeyHex, 'Codedeck Phone', token).catch((err) => {
      console.warn('[Store] pair-request publish failed:', err);
    });
  },

  dismissPairToast: () => set({ pairToast: null }),

  removeMachine: (pubkeyHex) => {
    disconnectFromMachine(pubkeyHex);
    set((state) => {
      const removedSessions = state.remoteSessions[pubkeyHex] ?? [];
      const removedIds = new Set(removedSessions.map(s => s.id));
      const { [pubkeyHex]: _, ...restSessions } = state.remoteSessions;
      // Clean up all per-session state for removed sessions
      const cleanedModes = { ...state.remoteSessionModes };
      const cleanedOutputs = { ...state.outputs };
      const cleanedUsage = { ...state.tokenUsage };
      const cleanedContext = { ...state.remoteSessionContext };
      const cleanedContextWindow = { ...state.remoteSessionContextWindow };
      const cleanedContextPercentage = { ...state.remoteSessionContextPercentage };
      const cleanedLoading = { ...state.historyLoading };
      for (const id of removedIds) {
        delete cleanedModes[id];
        delete cleanedOutputs[id];
        delete cleanedUsage[id];
        delete cleanedContext[id];
        delete cleanedContextWindow[id];
        delete cleanedContextPercentage[id];
        delete cleanedLoading[id];
        autoHistoryRequested.delete(id);
        seenBridgeSeqs.delete(id);
      }
      const { [pubkeyHex]: _folders, ...restFolders } = state.machineFolders;
      const { [pubkeyHex]: _protocol, ...restProtocol } = state.machineProtocolVersion;
      return {
        machines: state.machines.filter(m => m.pubkeyHex !== pubkeyHex),
        remoteSessions: restSessions,
        remoteSessionModes: cleanedModes,
        outputs: cleanedOutputs,
        tokenUsage: cleanedUsage,
        remoteSessionContext: cleanedContext,
        remoteSessionContextWindow: cleanedContextWindow,
        remoteSessionContextPercentage: cleanedContextPercentage,
        historyLoading: cleanedLoading,
        // Per-machine facts, not per-session: they'd otherwise outlive the machine and describe a
        // workspace (and a bridge version) the phone is no longer paired to.
        machineFolders: restFolders,
        machineProtocolVersion: restProtocol,
      };
    });
    persistSet('codedeck_machines', get().machines);
    // Stop foreground service if no machines remain
    if (get().machines.length === 0) {
      invoke('plugin:background-relay|stop_service').catch(() => {});
    }
  },

  initBridgeService: async (privateKeyHex) => {
    initBridge(privateKeyHex);

    // Always re-register handlers (they're just function pointers referencing
    // get/set closures, so re-registration is safe and ensures handlers use
    // the latest key after account switches)
    if (bridgeInitialized) {
      // Clean up the previous stale cleanup interval before re-registering
      if (staleCleanupInterval) { clearInterval(staleCleanupInterval); staleCleanupInterval = null; }
    }
    bridgeInitialized = true;

    setBridgeHandlers(
      // onSessionList — incremental merge, preserves pending placeholders, deduplicates
      ({ machine: _machineName, sessions: incomingSessions, authStatus, protocolVersion, folders }) => {
        const machines = get().machines;
        const machine = machines.find(m => m.hostname === _machineName) || machines[0];
        if (machine) {
          // Clear the refresh timeout since we got a response
          if (refreshTimeoutId !== null) {
            clearTimeout(refreshTimeoutId);
            refreshTimeoutId = null;
          }
          set((state) => {
            const existing = state.remoteSessions[machine.pubkeyHex] || [];
            const existingMap = new Map(existing.map(s => [s.id, s]));

            // Filter out dismissed sessions before merging
            const dismissedIds = state.dismissedSessionIds;
            const filtered = dismissedIds.size > 0
              ? incomingSessions.filter(s => !dismissedIds.has(s.id))
              : incomingSessions;
            // Deduplicate by session id (bridge may send dupes if multiple JSONL files share a sessionId)
            const dedupMap = new Map<string, RemoteSessionInfo>();
            for (const s of filtered) {
              const ex = dedupMap.get(s.id);
              if (!ex || s.lastActivity > ex.lastActivity) dedupMap.set(s.id, s);
            }
            const dedupedFiltered = [...dedupMap.values()];
            const incomingIds = new Set(dedupedFiltered.map(s => s.id));

            const newSessionModes: Record<string, AgentMode> = {};
            const newSessionEffort: Record<string, EffortLevel> = {};
            // Track the SDK-resolved context window the bridge reports (protocol v4+). It can change
            // mid-session (first result fills it; 1M beta toggles), so always take the latest value.
            const newSessionContextWindow: Record<string, number> = {};
            // The SDK's authoritative context-usage % (protocol v5+). Refreshed after each result;
            // 0 is a valid value, so compare against the stored value, not falsiness.
            const newSessionContextPercentage: Record<string, number> = {};
            const merged = dedupedFiltered.map(incoming => {
              if (incoming.contextWindow && state.remoteSessionContextWindow[incoming.id] !== incoming.contextWindow) {
                newSessionContextWindow[incoming.id] = incoming.contextWindow;
              }
              if (typeof incoming.contextPercentage === 'number'
                  && state.remoteSessionContextPercentage[incoming.id] !== incoming.contextPercentage) {
                newSessionContextPercentage[incoming.id] = incoming.contextPercentage;
              }
              const prev = existingMap.get(incoming.id);
              if (!prev) {
                // New session — initialize mode from bridge (default to 'plan')
                if (!state.remoteSessionModes[incoming.id]) {
                  newSessionModes[incoming.id] = incoming.permissionMode ?? 'plan';
                }
                // Initialize effort from bridge (default to 'auto')
                if (!state.remoteSessionEffort[incoming.id] && incoming.effortLevel) {
                  newSessionEffort[incoming.id] = incoming.effortLevel;
                }
                return incoming;
              }
              if (prev.title === incoming.title && prev.lastActivity === incoming.lastActivity
                  && prev.lineCount === incoming.lineCount && prev.project === incoming.project
                  && prev.cwd === incoming.cwd && prev.committed === incoming.committed
                  && prev.state === incoming.state && prev.contextWindow === incoming.contextWindow) {
                return prev; // unchanged — keep same reference
              }
              return { ...prev, ...incoming, title: incoming.title ?? prev.title }; // merge updates, preserve non-null title
            });

            // Preserve pending placeholders that haven't been resolved yet,
            // but remove any whose pendingId matches a real session that just arrived
            const pendingPlaceholders = existing.filter(s => {
              if (!s.id.startsWith('pending:')) return false;
              // Check if a real session arrived that resolves this pending
              // (pendingId is stored in the session id as 'pending:<pendingId>')
              const pendingId = s.id.slice(8);
              // If a real session with this pendingId already exists, remove the placeholder
              // (this handles the dedup from the onSessionList direction)
              return !state.pendingSessions.has(pendingId) ? false : !incomingIds.has(s.id);
            });
            if (pendingPlaceholders.length > 0) {
              merged.push(...pendingPlaceholders);
            }

            // Preserve optimistic placeholders (locally created, awaiting bridge ack) — the
            // bridge's session-list never contains them, so they'd otherwise be dropped before
            // reconciliation, yanking the session view out from under the user mid-type.
            const optimisticPlaceholders = existing.filter(
              s => s.id.startsWith('optimistic:') && !merged.some(m => m.id === s.id),
            );
            if (optimisticPlaceholders.length > 0) {
              merged.push(...optimisticPlaceholders);
            }

            // Preserve recently-ready sessions that aren't in the incoming list yet.
            // This covers the window between session-ready and the bridge indexing the JSONL.
            const READY_GRACE_MS = 90_000;
            const now = Date.now();
            const mergedIds = new Set(merged.map(s => s.id));
            for (const s of existing) {
              if (isLocalPlaceholder(s.id)) continue;
              if (mergedIds.has(s.id)) continue;
              const readyAt = state.sessionReadyTimestamps.get(s.id);
              if (readyAt && (now - readyAt) < READY_GRACE_MS) {
                merged.push(s);
              }
            }

            // Prune expired ready timestamps
            let readyTsPruned: Map<string, number> | undefined;
            for (const [id, ts] of state.sessionReadyTimestamps) {
              if (now - ts > READY_GRACE_MS) {
                if (!readyTsPruned) readyTsPruned = new Map(state.sessionReadyTimestamps);
                readyTsPruned.delete(id);
              }
            }

            // Prune expired dismissed session IDs (1 hour)
            const DISMISSED_MAX_AGE_MS = 60 * 60 * 1000;
            let dismissedPruned: Map<string, number> | undefined;
            for (const [id, ts] of state.dismissedSessionIds) {
              if (now - ts > DISMISSED_MAX_AGE_MS) {
                if (!dismissedPruned) dismissedPruned = new Map(state.dismissedSessionIds);
                dismissedPruned.delete(id);
              }
            }

            // Mark unread on the TRANSITION into a needs-attention state (or first sight of
            // a session that's already needy) — not on every snapshot, which would re-light
            // the dot for finished 'idle' sessions the user already read. Never auto-mark
            // the session the user is foreground-watching.
            const needsAttention = (st?: string) =>
              st === 'idle' || st === 'waiting_permission' || st === 'waiting_question';
            const visible = isAppVisible();
            let nextUnread: Set<string> | undefined;
            for (const incoming of dedupedFiltered) {
              const prev = existingMap.get(incoming.id);
              const becameNeedy = needsAttention(incoming.state) && (!prev || !needsAttention(prev.state));
              if (becameNeedy
                  && !(visible && incoming.id === state.activeSessionId)
                  && !state.unreadSessions.has(incoming.id)) {
                if (!nextUnread) nextUnread = new Set(state.unreadSessions);
                nextUnread.add(incoming.id);
              }
            }

            return {
              remoteSessions: { ...state.remoteSessions, [machine.pubkeyHex]: merged },
              ...(nextUnread ? { unreadSessions: nextUnread } : {}),
              remoteSessionModes: Object.keys(newSessionModes).length > 0
                ? { ...state.remoteSessionModes, ...newSessionModes }
                : state.remoteSessionModes,
              remoteSessionEffort: Object.keys(newSessionEffort).length > 0
                ? { ...state.remoteSessionEffort, ...newSessionEffort }
                : state.remoteSessionEffort,
              remoteSessionContextWindow: Object.keys(newSessionContextWindow).length > 0
                ? { ...state.remoteSessionContextWindow, ...newSessionContextWindow }
                : state.remoteSessionContextWindow,
              remoteSessionContextPercentage: Object.keys(newSessionContextPercentage).length > 0
                ? { ...state.remoteSessionContextPercentage, ...newSessionContextPercentage }
                : state.remoteSessionContextPercentage,
              refreshing: false,
              ...(readyTsPruned ? { sessionReadyTimestamps: readyTsPruned } : {}),
              ...(dismissedPruned ? { dismissedSessionIds: dismissedPruned } : {}),
              ...(authStatus ? {
                machines: state.machines.map(m =>
                  m.pubkeyHex === machine.pubkeyHex ? { ...m, authStatus } : m,
                ),
              } : {}),
              ...(protocolVersion !== undefined && state.machineProtocolVersion[machine.pubkeyHex] !== protocolVersion
                ? { machineProtocolVersion: { ...state.machineProtocolVersion, [machine.pubkeyHex]: protocolVersion } }
                : {}),
              // Same shape as the protocol version above: a per-machine fact carried on the
              // session list, replaced only when it actually changed so the New Session modal
              // doesn't re-render on every heartbeat.
              ...(folders !== undefined
                  && !arraysEqual(state.machineFolders[machine.pubkeyHex], folders)
                ? { machineFolders: { ...state.machineFolders, [machine.pubkeyHex]: folders } }
                : {}),
            };
          });

          // Persist remote session metadata (debounced, strips volatile fields)
          debouncedPersistRemoteSessions(get);

          // Reconcile permission modes: if the bridge observed a mode (from JSONL)
          // that differs from the phone's optimistic tracking, trust the bridge.
          const currentModes = get().remoteSessionModes;
          const modeUpdates: Record<string, AgentMode> = {};
          for (const s of incomingSessions) {
            const current = currentModes[s.id];
            const reported = s.permissionMode;
            if (!reported) continue;
            if (!current) {
              // New session — initialize mode from bridge
              modeUpdates[s.id] = reported;
            } else if (current !== reported) {
              modeUpdates[s.id] = reported;
            }
          }
          if (Object.keys(modeUpdates).length > 0) {
            set((state) => ({
              remoteSessionModes: { ...state.remoteSessionModes, ...modeUpdates },
            }));
          }

          // Auto-request history for sessions with no cached output (crash recovery)
          const currentOutputs = get().outputs;
          const currentLoading = get().historyLoading;
          const currentSessions = get().remoteSessions[machine.pubkeyHex] || [];
          const sessionsNeedingHistory = currentSessions
            .filter((s: RemoteSessionInfo) =>
              !isLocalPlaceholder(s.id)
              && (!currentOutputs[s.id] || currentOutputs[s.id].length === 0)
              && !currentLoading[s.id]
              && !autoHistoryRequested.has(s.id))
            .sort((a: RemoteSessionInfo, b: RemoteSessionInfo) => b.lastActivity.localeCompare(a.lastActivity))
            .slice(0, 10); // limit to 10 most recent

          for (let i = 0; i < sessionsNeedingHistory.length; i++) {
            const s = sessionsNeedingHistory[i];
            autoHistoryRequested.add(s.id);
            setTimeout(() => {
              get().requestSessionHistory(s.id);
            }, i * 500); // 500ms stagger to avoid flooding
          }

          // Unread marking is handled transition-based inside the merge `set` block above
          // (compares each session's new state against its previous state), so it no longer
          // re-lights the dot for finished 'idle' sessions on every snapshot.
        }
      },
      // onOutput
      (sessionId, entry, _seq) => {
        // Map remote output entry to Codedeck's OutputEntry format
        let entryType = mapRemoteEntryType(entry.entryType);
        // Split text entries by role
        if (entryType === 'message' && entry.metadata?.role === 'user') {
          entryType = 'user_message';
        }
        // Tag token usage system entries
        if (entryType === 'system' && entry.content.startsWith('Tokens:')) {
          entryType = 'token_usage';
        }
        const mapped: OutputEntry = {
          entry_type: entryType,
          content: entry.content,
          timestamp: entry.timestamp,
          metadata: { ...entry.metadata, bridgeSeq: _seq },
        };
        get().addOutput(sessionId, mapped);

        // OS notification + audible ping are both gated by the "Notifications" toggle.
        const notificationsEnabled = get().config.notifications_enabled;

        // Fire OS notification when Claude finishes responding
        if (notificationsEnabled && entry.metadata?.stream_end) {
          notifyIfNeeded({
            sessionId,
            activeSessionId: get().activeSessionId,
            type: 'session_complete',
          });
        }

        // Fire OS notification for interactive entries when app is backgrounded
        const special = entry.metadata?.special as string | undefined;
        if (notificationsEnabled && (special === 'permission_request' || special === 'plan_approval' || special === 'ask_question')) {
          notifyIfNeeded({
            sessionId,
            activeSessionId: get().activeSessionId,
            type: special,
            toolName: special === 'permission_request' ? (entry.metadata?.tool_name as string) : undefined,
          });
        }

        // Track pending AskUserQuestion so InputBar can route through question-input
        if (special === 'ask_question') {
          const options = entry.metadata?.options as Array<{ label: string }> | undefined;
          if (options && options.length > 0) {
            set((state) => {
              const next = new Map(state.pendingQuestions);
              next.set(sessionId, { optionCount: options.length });
              return { pendingQuestions: next };
            });
          }
        }

        // Detect autonomous plan mode entry from EnterPlanMode tool_use
        if (entry.entryType === 'tool_use' && entry.metadata?.tool_name === 'EnterPlanMode') {
          set((state) => ({
            remoteSessionModes: { ...state.remoteSessionModes, [sessionId]: 'plan' },
          }));
        }

        // Clear pending question when the question resolves (tool_result or new user/assistant turn)
        if (entryType === 'tool_result' || entryType === 'user_message' || (entryType === 'message' && entry.metadata?.role === 'assistant')) {
          if (get().pendingQuestions.has(sessionId)) {
            get().clearPendingQuestion(sessionId);
          }
        }
      },
      // onStatus
      (machineName, status) => {
        set((state) => ({
          machines: state.machines.map(m =>
            m.hostname === machineName ? { ...m, connected: status === 'connected' } : m,
          ),
        }));
      },
      // onHistory (supports chunked responses from bridge)
      (sessionId, entries, _totalEntries, chunkIndex, totalChunks, _requestId) => {
        // Add entries immediately (progressive rendering)
        for (const { entry, seq } of entries) {
          let entryType = mapRemoteEntryType(entry.entryType);
          if (entryType === 'message' && entry.metadata?.role === 'user') {
            entryType = 'user_message';
          }
          if (entryType === 'system' && entry.content.startsWith('Tokens:')) {
            entryType = 'token_usage';
          }
          const mapped: OutputEntry = {
            entry_type: entryType,
            content: entry.content,
            timestamp: entry.timestamp,
            metadata: { ...entry.metadata, bridgeSeq: seq },
          };
          get().addOutput(sessionId, mapped);
        }

        // Backward compat: if no chunk fields, sort and clear (old bridge)
        if (chunkIndex === undefined || totalChunks === undefined) {
          sortOutputsBySeq(sessionId, set);
          clearHistoryLoading(sessionId, set);
          return;
        }

        // Chunked response: track progress by requestId (race-free)
        const trackingKey = _requestId ?? sessionId; // fallback for old bridges without requestId
        let tracker = historyChunkTrackers.get(trackingKey);
        if (!tracker) {
          tracker = { sessionId, totalChunks, receivedCount: 0, timeoutId: 0 as unknown as ReturnType<typeof setTimeout> };
          historyChunkTrackers.set(trackingKey, tracker);
        }

        tracker.receivedCount++;
        sortOutputsBySeq(sessionId, set);

        // Reset idle timeout on every chunk
        clearTimeout(tracker.timeoutId);

        if (tracker.receivedCount >= tracker.totalChunks) {
          // All chunks received
          historyChunkTrackers.delete(trackingKey);
          clearHistoryLoading(sessionId, set);
        } else {
          // Set idle timeout — clear loading if no more chunks arrive
          const key = trackingKey;
          tracker.timeoutId = setTimeout(() => {
            const t = historyChunkTrackers.get(key);
            console.warn(`[SessionStore] History timeout for ${sessionId}: received ${t?.receivedCount ?? 0}/${totalChunks} chunks`);
            historyChunkTrackers.delete(key);
            clearHistoryLoading(sessionId, set);
          }, HISTORY_IDLE_TIMEOUT_MS);
        }
      },
      // onSessionPending — insert placeholder into remoteSessions
      (pendingId, machineName, createdAt) => {
        const machines = get().machines;
        const machine = machines.find(m => m.hostname === machineName) || machines[0];
        if (!machine) return;

        // Optimistic adoption: if we have an outstanding locally-created session for this
        // machine, this pending belongs to it. Record the association and skip the bridge
        // placeholder — the optimistic row is already on screen serving the same purpose.
        {
          const queue = get().optimisticQueueByMachine.get(machine.pubkeyHex);
          const localId = queue?.find(id => {
            const e = get().optimisticSessions.get(id);
            return e?.status === 'starting' && !e.pendingId;
          });
          if (localId) {
            set((state) => {
              const next = new Map(state.optimisticSessions);
              const entry = next.get(localId);
              if (!entry) return {};
              next.set(localId, { ...entry, pendingId });
              return { optimisticSessions: next };
            });
            return;
          }
        }

        // 2-minute client-side cleanup timer
        const timeoutId = setTimeout(() => {
          console.warn(`[SessionStore] Pending session ${pendingId} expired (2min cleanup)`);
          const pending = new Map(get().pendingSessions); // copy before mutating
          if (pending.has(pendingId)) {
            pending.delete(pendingId);
            set((state) => {
              const existing = state.remoteSessions[machine.pubkeyHex] || [];
              return {
                remoteSessions: {
                  ...state.remoteSessions,
                  [machine.pubkeyHex]: existing.filter(s => s.id !== `pending:${pendingId}`),
                },
                pendingSessions: pending,
              };
            });
          }
        }, 120_000);

        // Track in pendingSessions
        const pending = new Map(get().pendingSessions);
        pending.set(pendingId, { pendingId, machine: machineName, createdAt, timeoutId });

        // Insert placeholder RemoteSessionInfo
        const placeholder: RemoteSessionInfo = {
          id: `pending:${pendingId}`,
          slug: 'Starting...',
          cwd: '',
          lastActivity: createdAt,
          lineCount: 0,
          title: null,
          project: 'Waiting for Claude Code...',
        };

        set((state) => {
          const existing = state.remoteSessions[machine.pubkeyHex] || [];
          return {
            remoteSessions: {
              ...state.remoteSessions,
              [machine.pubkeyHex]: [...existing, placeholder],
            },
            pendingSessions: pending,
          };
        });
      },
      // onSessionReady — replace placeholder with real session, set active, switch panel
      (pendingId, session) => {
        // Optimistic adoption: match by recorded pendingId, else (ready-before-pending)
        // the sole outstanding optimistic create.
        {
          const optMap = get().optimisticSessions;
          let adoptLocalId: string | undefined;
          for (const [lid, entry] of optMap) {
            if (entry.pendingId === pendingId) { adoptLocalId = lid; break; }
          }
          if (!adoptLocalId) {
            const starting = [...optMap.values()].filter(e => e.status === 'starting' && !e.pendingId);
            if (starting.length === 1) adoptLocalId = starting[0].localId;
          }
          if (adoptLocalId) {
            adoptOptimisticSession(adoptLocalId, session, set, get);
            return;
          }
        }

        const pending = new Map(get().pendingSessions); // copy before mutating
        const entry = pending.get(pendingId);
        if (entry) {
          clearTimeout(entry.timeoutId);
          pending.delete(pendingId);
        }

        set((state) => {
          const newRemoteSessions = { ...state.remoteSessions };

          // Try to find the machine that has the pending placeholder
          let foundPlaceholder = false;
          for (const [pubkeyHex, sessions] of Object.entries(newRemoteSessions)) {
            const idx = sessions.findIndex(s => s.id === `pending:${pendingId}`);
            if (idx >= 0) {
              // Remove placeholder, add real session (dedup: check if real session already exists)
              const filtered = sessions.filter(s => s.id !== `pending:${pendingId}` && s.id !== session.id);
              filtered.push(session);
              newRemoteSessions[pubkeyHex] = filtered;
              foundPlaceholder = true;
              break;
            }
          }

          // If session-ready arrived before session-pending (out-of-order delivery),
          // insert the session directly under the first machine that has sessions
          if (!foundPlaceholder) {
            const machineKeys = Object.keys(newRemoteSessions);
            const targetKey = machineKeys[0] ?? get().machines[0]?.pubkeyHex;
            if (targetKey) {
              const existing = newRemoteSessions[targetKey] || [];
              if (!existing.some(s => s.id === session.id)) {
                newRemoteSessions[targetKey] = [...existing, session];
              }
            }
          }

          // Track when this session became ready — protects it from being dropped
          // by an incoming session-list that doesn't include it yet (JSONL lag)
          const readyTs = new Map(state.sessionReadyTimestamps);
          readyTs.set(session.id, Date.now());

          return {
            remoteSessions: newRemoteSessions,
            activeSessionId: session.id,
            pendingSessions: new Map(pending),
            sessionReadyTimestamps: readyTs,
            // Seed effort from session-ready payload so UI shows correct level immediately
            ...(session.effortLevel && !state.remoteSessionEffort[session.id]
              ? { remoteSessionEffort: { ...state.remoteSessionEffort, [session.id]: session.effortLevel } }
              : {}),
            // Seed model from session-ready payload so UI shows correct model immediately
            ...(session.model && !state.remoteSessionModel[session.id]
              ? { remoteSessionModel: { ...state.remoteSessionModel, [session.id]: session.model } }
              : {}),
            // Seed the real context window if the bridge already reported one
            ...(session.contextWindow && !state.remoteSessionContextWindow[session.id]
              ? { remoteSessionContextWindow: { ...state.remoteSessionContextWindow, [session.id]: session.contextWindow } }
              : {}),
            // Seed the SDK's context-usage % if the bridge already reported one (0 is valid)
            ...(typeof session.contextPercentage === 'number' && state.remoteSessionContextPercentage[session.id] === undefined
              ? { remoteSessionContextPercentage: { ...state.remoteSessionContextPercentage, [session.id]: session.contextPercentage } }
              : {}),
          };
        });
        debouncedPersistRemoteSessions(get);
      },
      // onSessionFailed — remove placeholder
      (pendingId, reason) => {
        console.warn(`[SessionStore] Session failed: ${pendingId} (${reason})`);

        // Optimistic session failure: keep the row visible, surface the error + retry.
        {
          const optMap = get().optimisticSessions;
          let failLocalId: string | undefined;
          for (const [lid, entry] of optMap) {
            if (entry.pendingId === pendingId) { failLocalId = lid; break; }
          }
          if (!failLocalId) {
            const starting = [...optMap.values()].filter(e => e.status === 'starting' && !e.pendingId);
            if (starting.length === 1) failLocalId = starting[0].localId;
          }
          if (failLocalId) {
            const opt = optMap.get(failLocalId);
            if (opt) clearTimeout(opt.timeoutId);
            get().addOutput(`optimistic:${failLocalId}`, {
              entry_type: 'error',
              content: `Session failed to start (${reason}). Tap Retry to try again.`,
              timestamp: new Date().toISOString(),
            });
            set((state) => {
              const next = new Map(state.optimisticSessions);
              const entry = next.get(failLocalId);
              if (!entry) return {};
              next.set(failLocalId, { ...entry, status: 'failed' });
              const queue = new Map(state.optimisticQueueByMachine);
              queue.set(entry.machinePubkeyHex, (queue.get(entry.machinePubkeyHex) || []).filter(id => id !== failLocalId));
              return { optimisticSessions: next, optimisticQueueByMachine: queue };
            });
            return;
          }
        }

        const pending = new Map(get().pendingSessions); // copy before mutating
        const entry = pending.get(pendingId);
        if (entry) {
          clearTimeout(entry.timeoutId);
          pending.delete(pendingId);
        }

        set((state) => {
          const newRemoteSessions = { ...state.remoteSessions };
          for (const [pubkeyHex, sessions] of Object.entries(newRemoteSessions)) {
            const idx = sessions.findIndex(s => s.id === `pending:${pendingId}`);
            if (idx >= 0) {
              newRemoteSessions[pubkeyHex] = sessions.filter(s => s.id !== `pending:${pendingId}`);
              break;
            }
          }
          return {
            remoteSessions: newRemoteSessions,
            pendingSessions: new Map(pending),
          };
        });
      },
      // onInputFailed — show error in session output and reset permission cards
      (sessionId, reason) => {
        const message = reason === 'no-terminal'
          ? 'No active terminal for this session. The Claude Code terminal may have closed — try creating a new session.'
          : 'Input delivery timed out. The bridge could not route your message.';
        get().addOutput(sessionId, {
          entry_type: 'error',
          content: message,
          timestamp: new Date().toISOString(),
        });

        // Clear responded state for permission cards so user can retry
        set((state) => {
          if (!state.respondedCards.has(sessionId)) return {};
          const next = new Map(state.respondedCards);
          next.delete(sessionId);
          return { respondedCards: next };
        });
      },
      // onCloseSessionAck — no-op (handled elsewhere)
      undefined,
      // onSessionReplaced — swap old session for new one at same sidebar position
      (oldSessionId, newSession) => {
        console.log(`[SessionStore] Session replaced: ${oldSessionId} → ${newSession.id}`);
        set((state) => {
          const newRemoteSessions = { ...state.remoteSessions };

          // Find the machine containing the old session
          for (const [pubkeyHex, sessions] of Object.entries(newRemoteSessions)) {
            const idx = sessions.findIndex(s => s.id === oldSessionId);
            if (idx >= 0) {
              // Replace at same index (preserves sidebar position)
              const updated = [...sessions];
              updated[idx] = newSession;
              newRemoteSessions[pubkeyHex] = updated;
              break;
            }
          }

          // Transfer mode and effort, clear old outputs (context was cleared)
          const newModes = { ...state.remoteSessionModes };
          if (newModes[oldSessionId]) {
            newModes[newSession.id] = newModes[oldSessionId];
            delete newModes[oldSessionId];
          }
          const newEffort = { ...state.remoteSessionEffort };
          if (newEffort[oldSessionId]) {
            newEffort[newSession.id] = newEffort[oldSessionId];
            delete newEffort[oldSessionId];
          }

          const newOutputs = { ...state.outputs };
          delete newOutputs[oldSessionId];

          const newTokenUsage = { ...state.tokenUsage };
          delete newTokenUsage[oldSessionId];

          // Clear responded cards for old session
          const newRespondedCards = new Map(state.respondedCards);
          newRespondedCards.delete(oldSessionId);

          return {
            remoteSessions: newRemoteSessions,
            remoteSessionModes: newModes,
            remoteSessionEffort: newEffort,
            outputs: newOutputs,
            tokenUsage: newTokenUsage,
            respondedCards: newRespondedCards,
            activeSessionId: state.activeSessionId === oldSessionId ? newSession.id : state.activeSessionId,
          };
        });
        debouncedPersistRemoteSessions(get);
      },
      // onModeConfirmed — fast feedback from bridge after mode switch
      (sessionId: string, mode: AgentMode) => {
        set((state) => ({
          remoteSessionModes: { ...state.remoteSessionModes, [sessionId]: mode },
        }));
        get().clearSettingPending(sessionId);
        // "New GSD project" waits here: the command is only safe to send once the session has
        // actually left plan mode (CD-058).
        fireGsdKickoff(sessionId, get);
      },
      // onEffortConfirmed — fast feedback from bridge after effort change
      (sessionId: string, level: EffortLevel) => {
        set((state) => ({
          remoteSessionEffort: { ...state.remoteSessionEffort, [sessionId]: level },
        }));
        get().clearSettingPending(sessionId);
      },
      // onModelConfirmed — fast feedback from bridge after model change
      (sessionId: string, model: string) => {
        set((state) => ({
          remoteSessionModel: { ...state.remoteSessionModel, [sessionId]: model },
        }));
        get().clearSettingPending(sessionId);
      },
      // onCredentialsAck — bridge confirms credential storage, update machine immediately
      (machineName: string, success: boolean, hasAnthropicKey: boolean, hasGithubPat: boolean, keyValid?: boolean, error?: string) => {
        if (success) {
          console.log(`[Store] Credentials saved on ${machineName} (hasKey=${hasAnthropicKey}, hasPat=${hasGithubPat}, valid=${keyValid})`);
          set((state) => ({
            machines: state.machines.map(m =>
              m.hostname === machineName
                ? { ...m, authStatus: { hasAnthropicKey, hasGithubPat, hasEnvKey: m.authStatus?.hasEnvKey ?? false } }
                : m,
            ),
          }));
        } else {
          console.error(`[Store] Failed to save credentials on ${machineName}: ${error}`);
        }
      },
      // onPairAck — bridge confirms (or rejects) an auto-pairing request
      (machineName: string, ok: boolean, reason?: string) => {
        if (ok) {
          console.log(`[Store] Auto-paired with ${machineName}`);
          set((state) => ({
            machines: state.machines.map(m =>
              m.hostname === machineName ? { ...m, connected: true } : m,
            ),
            pairToast: { machine: machineName },
          }));
          // Auto-dismiss the toast after a few seconds
          setTimeout(() => {
            if (get().pairToast?.machine === machineName) set({ pairToast: null });
          }, 4000);
        } else {
          console.warn(`[Store] Pairing rejected by ${machineName}: ${reason ?? 'unknown'}`);
        }
      },
      // onUsage — subscription usage snapshot pushed by the bridge (on request or heartbeat)
      (sessionId: string, usage: UsageData) => {
        set((state) => ({
          remoteSessionUsage: { ...state.remoteSessionUsage, [sessionId]: usage },
        }));
      },
      // onGsdState — GSD workflow snapshot. Stored even when `available: false`, so a session
      // that moves off a GSD project retires its strip instead of showing a stale one.
      (sessionId: string, gsd: GsdState) => {
        set((state) => ({
          remoteSessionGsd: { ...state.remoteSessionGsd, [sessionId]: gsd },
        }));
      },
    );

    const savedGsdEnabled = await persistGet<Record<string, boolean>>('codedeck_gsd_enabled');
    if (savedGsdEnabled && typeof savedGsdEnabled === 'object') {
      set({ gsdEnabledSessions: savedGsdEnabled });
    }
    const savedGsdStarted = await persistGet<Record<string, boolean>>('codedeck_gsd_started');
    if (savedGsdStarted && typeof savedGsdStarted === 'object') {
      set({ gsdStartedSessions: savedGsdStarted });
    }

    // Restore persisted remote session metadata (titles, etc.) before connecting
    const savedSessions = await persistGet<Record<string, RemoteSessionInfo[]>>('codedeck_remote_sessions');
    if (savedSessions && typeof savedSessions === 'object') {
      set({ remoteSessions: savedSessions });
    }

    // Reconnect to all saved machines
    const saved = await persistGet<RemoteMachine[]>('codedeck_machines');
    if (saved && Array.isArray(saved)) {
      set({ machines: saved });
      for (const machine of saved) {
        connectToMachine(machine);
      }
    }

    // Stale cleanup: every 30s, remove pending placeholders older than 2 minutes
    if (staleCleanupInterval) clearInterval(staleCleanupInterval);
    staleCleanupInterval = setInterval(() => {
      const now = Date.now();
      const pending = new Map(get().pendingSessions); // copy before mutating
      const stale: string[] = [];
      for (const [pendingId, entry] of pending) {
        if (now - new Date(entry.createdAt).getTime() > 120_000) {
          stale.push(pendingId);
        }
      }
      if (stale.length > 0) {
        for (const pendingId of stale) {
          const entry = pending.get(pendingId);
          if (entry) clearTimeout(entry.timeoutId);
          pending.delete(pendingId);
        }
        set((state) => {
          const newRemoteSessions = { ...state.remoteSessions };
          for (const [pubkeyHex, sessions] of Object.entries(newRemoteSessions)) {
            const filtered = sessions.filter(s => !stale.some(pid => s.id === `pending:${pid}`));
            if (filtered.length !== sessions.length) {
              newRemoteSessions[pubkeyHex] = filtered;
            }
          }
          return { remoteSessions: newRemoteSessions, pendingSessions: pending };
        });
      }
    }, 30_000);
  },

  isRemoteSession: (sessionId) => {
    const { remoteSessions } = get();
    for (const sessions of Object.values(remoteSessions)) {
      if (sessions?.some(s => s.id === sessionId)) return true;
    }
    return false;
  },

  isBridgeOffline: (sessionId) => {
    const machine = get().getMachineForSession(sessionId);
    return machine ? !machine.connected : false;
  },

  getMachineForSession: (sessionId) => {
    const { remoteSessions, machines } = get();
    for (const [pubkeyHex, sessions] of Object.entries(remoteSessions)) {
      if (sessions?.some(s => s.id === sessionId)) {
        return machines.find(m => m.pubkeyHex === pubkeyHex) ?? null;
      }
    }
    return null;
  },

  requestRefreshSessions: () => {
    set({ refreshing: true });
    // Cancel previous timeout to prevent early reset on rapid pulls
    if (refreshTimeoutId !== null) {
      clearTimeout(refreshTimeoutId);
    }
    const machines = get().machines.filter(m => m.connected);
    for (const machine of machines) {
      sendRefreshRequest(machine).catch(err => {
        console.error(`[SessionStore] Failed to send refresh request to ${machine.hostname}:`, err);
      });
    }
    // Timeout: reset refreshing after 3s if no session list arrives
    refreshTimeoutId = setTimeout(() => {
      refreshTimeoutId = null;
      if (get().refreshing) {
        set({ refreshing: false });
      }
    }, 3_000);
  },

  createRemoteSession: async (machine, opts) => {
    try {
      const { default_effort: defaultEffort, model: configModel } = get().config;
      await sendCreateSessionRequest(
        machine,
        defaultEffort !== 'auto' ? defaultEffort : undefined,
        opts?.model ?? (configModel || undefined),
        opts?.testSession,
        opts?.cwd,
        opts?.createCwd,
      );
    } catch (e) {
      console.error('[SessionStore] Failed to create remote session:', e);
    }
  },

  startOptimisticRemoteSession: (machine, opts) => {
    const { testSession, model, cwd, createCwd, gsd } = opts ?? {};
    const localId = crypto.randomUUID();
    const rowId = `optimistic:${localId}`;
    const { default_effort: defaultEffort, model: configModel } = get().config;
    const effortLevel: EffortLevel | undefined = defaultEffort !== 'auto' ? defaultEffort : undefined;
    const resolvedModel = model ?? (configModel || undefined);
    const now = new Date().toISOString();

    const placeholder: RemoteSessionInfo = {
      id: rowId,
      slug: 'Starting…',
      cwd: '',
      lastActivity: now,
      lineCount: 0,
      title: null,
      project: 'Starting session…',
      permissionMode: 'plan',
      effortLevel,
      model: resolvedModel,
      state: 'running',
    };

    const timeoutId = armOptimisticTimeout(localId, set, get);

    set((state) => {
      const existing = state.remoteSessions[machine.pubkeyHex] || [];
      const queue = new Map(state.optimisticQueueByMachine);
      queue.set(machine.pubkeyHex, [...(queue.get(machine.pubkeyHex) || []), localId]);
      const optimistic = new Map(state.optimisticSessions);
      optimistic.set(localId, {
        localId,
        machinePubkeyHex: machine.pubkeyHex,
        createdAt: now,
        model: resolvedModel,
        effortLevel,
        testSession: !!testSession,
        cwd,
        createCwd,
        gsd,
        bufferedMessages: [],
        timeoutId,
        status: 'starting',
      });
      return {
        remoteSessions: { ...state.remoteSessions, [machine.pubkeyHex]: [...existing, placeholder] },
        activeSessionId: rowId,
        optimisticSessions: optimistic,
        optimisticQueueByMachine: queue,
        remoteSessionModes: { ...state.remoteSessionModes, [rowId]: 'plan' as AgentMode },
        // Seed model/effort so the InputBar pills are correct from the first frame.
        ...(resolvedModel ? { remoteSessionModel: { ...state.remoteSessionModel, [rowId]: resolvedModel } } : {}),
        ...(effortLevel ? { remoteSessionEffort: { ...state.remoteSessionEffort, [rowId]: effortLevel } } : {}),
      };
    });

    // Render the session view (default panel is already 'session', but force it in case
    // the user was in DMs/settings when they tapped Start Session).
    useUIStore.getState().setPanelMode('session');

    // Subtle progress line so the OutputStream isn't blank while the bridge spins up.
    get().addOutput(rowId, {
      entry_type: 'system',
      content: gsd ? 'Starting session — GSD will begin as soon as it is live…' : 'Starting session…',
      timestamp: now,
    });

    // Fire the real create over the wire — don't block the UI on it.
    void get().createRemoteSession(machine, { testSession, model: resolvedModel, cwd, createCwd });
  },

  retryOptimisticSession: (localId) => {
    const opt = get().optimisticSessions.get(localId);
    if (!opt) return;
    const machine = get().machines.find(m => m.pubkeyHex === opt.machinePubkeyHex);
    if (!machine) return;
    clearTimeout(opt.timeoutId);
    const timeoutId = armOptimisticTimeout(localId, set, get);
    set((state) => {
      const next = new Map(state.optimisticSessions);
      const entry = next.get(localId);
      if (!entry) return {};
      next.set(localId, { ...entry, status: 'starting', pendingId: undefined, timeoutId });
      const queue = new Map(state.optimisticQueueByMachine);
      const list = queue.get(machine.pubkeyHex) || [];
      if (!list.includes(localId)) queue.set(machine.pubkeyHex, [...list, localId]);
      return { optimisticSessions: next, optimisticQueueByMachine: queue };
    });
    get().addOutput(`optimistic:${localId}`, { entry_type: 'system', content: 'Retrying…', timestamp: new Date().toISOString() });
    void get().createRemoteSession(machine, {
      testSession: opt.testSession,
      model: opt.model,
      cwd: opt.cwd,
      createCwd: opt.createCwd,
    });
  },

  deleteRemoteSession: (sessionId) => {
    // A GSD command still armed for a session being deleted must not fire into the void.
    cancelGsdKickoff(sessionId);

    // Cancel any previous pending delete (auto-commits it immediately)
    if (pendingDeleteTimer) {
      clearTimeout(pendingDeleteTimer);
      pendingDeleteTimer = null;
      if (pendingDeleteSnapshot) {
        const prev = pendingDeleteSnapshot;
        if (prev.machine) {
          sendCloseSessionRequest(prev.machine, prev.sessionId).catch(() => {});
        }
        pendingDeleteSnapshot = null;
      }
    }

    // 1. Snapshot state for undo
    const machine = get().getMachineForSession(sessionId);
    let sessionInfo: RemoteSessionInfo | null = null;
    let machineKey: string | null = null;
    for (const [key, sessions] of Object.entries(get().remoteSessions)) {
      const found = sessions.find(s => s.id === sessionId);
      if (found) { sessionInfo = found; machineKey = key; break; }
    }
    pendingDeleteSnapshot = {
      sessionId,
      machine,
      sessionInfo,
      machineKey,
      outputs: get().outputs[sessionId] || [],
      tokenUsage: get().tokenUsage[sessionId] || null,
      mode: get().remoteSessionModes[sessionId] || null,
      effort: get().remoteSessionEffort[sessionId] || null,
      model: get().remoteSessionModel[sessionId] || null,
    };

    // 2. Add to dismissed map with timestamp
    const dismissed = new Map(get().dismissedSessionIds);
    dismissed.set(sessionId, Date.now());

    // 3. Optimistic local removal
    set((state) => {
      const newRemoteSessions = { ...state.remoteSessions };
      for (const [pubkeyHex, sessions] of Object.entries(newRemoteSessions)) {
        const filtered = sessions.filter(s => s.id !== sessionId);
        if (filtered.length !== sessions.length) {
          newRemoteSessions[pubkeyHex] = filtered;
        }
      }

      const { [sessionId]: _o, ...restOutputs } = state.outputs;
      const { [sessionId]: _t, ...restUsage } = state.tokenUsage;
      const { [sessionId]: _m, ...restModes } = state.remoteSessionModes;
      const { [sessionId]: _e, ...restEffort } = state.remoteSessionEffort;
      const { [sessionId]: _mo, ...restModel } = state.remoteSessionModel;
      const { [sessionId]: _p, ...restPending } = state.remoteSettingPending;
      const { [sessionId]: _su, ...restSessionUsage } = state.remoteSessionUsage;
      const { [sessionId]: _gsd, ...restSessionGsd } = state.remoteSessionGsd;
      const { [sessionId]: _ge, ...restGsdEnabled } = state.gsdEnabledSessions;
      const { [sessionId]: _gs, ...restGsdStarted } = state.gsdStartedSessions;
      const { [sessionId]: _ctx, ...restContext } = state.remoteSessionContext;
      const { [sessionId]: _cw, ...restContextWindow } = state.remoteSessionContextWindow;
      const { [sessionId]: _cp, ...restContextPercentage } = state.remoteSessionContextPercentage;
      const { [sessionId]: _h, ...restLoading } = state.historyLoading;

      // Clean up grace-period tracking for deleted session
      const readyTs = new Map(state.sessionReadyTimestamps);
      readyTs.delete(sessionId);

      return {
        remoteSessions: newRemoteSessions,
        outputs: restOutputs,
        tokenUsage: restUsage,
        remoteSessionModes: restModes,
        remoteSessionEffort: restEffort,
        remoteSessionModel: restModel,
        remoteSettingPending: restPending,
        remoteSessionUsage: restSessionUsage,
        remoteSessionGsd: restSessionGsd,
        gsdEnabledSessions: restGsdEnabled,
        gsdStartedSessions: restGsdStarted,
        remoteSessionContext: restContext,
        remoteSessionContextWindow: restContextWindow,
        remoteSessionContextPercentage: restContextPercentage,
        historyLoading: restLoading,
        dismissedSessionIds: dismissed,
        sessionReadyTimestamps: readyTs,
        activeSessionId: state.activeSessionId === sessionId ? null : state.activeSessionId,
        undoToast: { sessionId, label: sessionInfo?.title || sessionInfo?.slug || 'Session' },
      };
    });

    seenBridgeSeqs.delete(sessionId);
    autoHistoryRequested.delete(sessionId);
    clearSettingRevertTimer(sessionId);
    debouncedPersistRemoteSessions(get);

    // 4. Defer bridge close-session by UNDO_DELAY_MS
    pendingDeleteTimer = setTimeout(() => {
      pendingDeleteTimer = null;
      const snap = pendingDeleteSnapshot;
      pendingDeleteSnapshot = null;
      if (snap?.machine) {
        sendCloseSessionRequest(snap.machine, snap.sessionId).catch(err => {
          console.error('[SessionStore] Failed to send close-session:', err);
        });
      }
      set({ undoToast: null });
    }, UNDO_DELAY_MS);
  },

  undoDeleteSession: () => {
    // Cancel the deferred bridge message
    if (pendingDeleteTimer) {
      clearTimeout(pendingDeleteTimer);
      pendingDeleteTimer = null;
    }

    const snap = pendingDeleteSnapshot;
    pendingDeleteSnapshot = null;
    if (!snap) return;

    // Remove from dismissed map
    const dismissed = new Map(get().dismissedSessionIds);
    dismissed.delete(snap.sessionId);

    // Restore local state
    set((state) => {
      const newRemoteSessions = { ...state.remoteSessions };
      if (snap.machineKey && snap.sessionInfo) {
        const existing = newRemoteSessions[snap.machineKey] || [];
        if (!existing.some(s => s.id === snap.sessionId)) {
          newRemoteSessions[snap.machineKey] = [...existing, snap.sessionInfo];
        }
      }

      return {
        remoteSessions: newRemoteSessions,
        outputs: snap.outputs.length > 0
          ? { ...state.outputs, [snap.sessionId]: snap.outputs }
          : state.outputs,
        tokenUsage: snap.tokenUsage
          ? { ...state.tokenUsage, [snap.sessionId]: snap.tokenUsage }
          : state.tokenUsage,
        remoteSessionModes: snap.mode
          ? { ...state.remoteSessionModes, [snap.sessionId]: snap.mode }
          : state.remoteSessionModes,
        remoteSessionEffort: snap.effort
          ? { ...state.remoteSessionEffort, [snap.sessionId]: snap.effort }
          : state.remoteSessionEffort,
        remoteSessionModel: snap.model
          ? { ...state.remoteSessionModel, [snap.sessionId]: snap.model }
          : state.remoteSessionModel,
        remoteSessionContextWindow: snap.sessionInfo?.contextWindow
          ? { ...state.remoteSessionContextWindow, [snap.sessionId]: snap.sessionInfo.contextWindow }
          : state.remoteSessionContextWindow,
        remoteSessionContextPercentage: typeof snap.sessionInfo?.contextPercentage === 'number'
          ? { ...state.remoteSessionContextPercentage, [snap.sessionId]: snap.sessionInfo.contextPercentage }
          : state.remoteSessionContextPercentage,
        dismissedSessionIds: dismissed,
        undoToast: null,
      };
    });

    debouncedPersistRemoteSessions(get);
  },

  respondRemotePermission: async (sessionId, requestId, allow, modifier) => {
    set((state) => clearUnread(state, sessionId));
    const machine = get().getMachineForSession(sessionId);
    if (!machine) {
      console.warn('[SessionStore] respondRemotePermission: no machine for session', sessionId);
      return;
    }
    try {
      await sendRemotePermissionResponse(machine, sessionId, requestId, allow, modifier);
    } catch (e) {
      console.error('[SessionStore] Failed to send permission response:', e);
    }
  },

  sendRemoteKeypress: async (sessionId, key, context?) => {
    set((state) => clearUnread(state, sessionId));
    const machine = get().getMachineForSession(sessionId);
    if (!machine) {
      console.warn('[SessionStore] sendRemoteKeypress: no machine for session', sessionId);
      return;
    }
    try {
      await sendRemoteKeypress(machine, sessionId, key, context);
    } catch (e) {
      console.error('[SessionStore] Failed to send keypress:', e);
    }
  },

  answerQuestion: async (sessionId, text) => {
    set((state) => clearUnread(state, sessionId));
    const pending = get().pendingQuestions.get(sessionId);
    get().clearPendingQuestion(sessionId);
    const machine = get().getMachineForSession(sessionId);
    if (!machine) {
      console.warn('[SessionStore] answerQuestion: no machine for session', sessionId);
      return;
    }
    try {
      await sendRemoteQuestionInput(machine, sessionId, text, pending?.optionCount ?? 0);
    } catch (e) {
      console.error('[SessionStore] Failed to send question answer:', e);
    }
  },

  reconnectBridge: () => {
    const { machines } = get();
    if (machines.length > 0) {
      reconnectAllMachines(machines);
    }
  },

  requestSessionHistory: async (sessionId) => {
    const machine = get().getMachineForSession(sessionId);
    if (!machine) { return; }
    set((state) => ({
      historyLoading: { ...state.historyLoading, [sessionId]: true },
    }));
    try {
      await sendHistoryRequest(machine, sessionId);
    } catch (e) {
      console.error('[SessionStore] Failed to request history:', e);
      set((state) => {
        const { [sessionId]: _, ...rest } = state.historyLoading;
        return { historyLoading: rest };
      });
    }
  },
}));

function mapRemoteEntryType(entryType: RemoteOutputEntry['entryType']): OutputEntry['entry_type'] {
  switch (entryType) {
    case 'text': return 'message';
    case 'tool_use': return 'tool_use';
    case 'tool_result': return 'tool_result';
    case 'system': return 'system';
    case 'error': return 'error';
    case 'progress': return 'system';
    default: return 'message';
  }
}
