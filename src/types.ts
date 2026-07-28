export type SessionState = 'idle' | 'running' | 'waiting_permission' | 'completed' | 'error';
export type AgentMode = 'default' | 'acceptEdits' | 'plan';
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';
export type OutputType = 'action' | 'diff' | 'message' | 'text' | 'error' | 'system' | 'tool_use' | 'tool_result' | 'user_message' | 'token_usage';
export type GitSyncStatus = 'synced' | 'pending_push' | 'push_failed' | 'never_pushed';

export interface Session {
  id: string;
  name: string;
  group: string;
  repo_url: string;
  branch: string;
  workspace_path: string;
  state: SessionState;
  mode: AgentMode;
  created_at: string;
  last_activity: string;
  pending_permissions: PermissionRequest[];
  git_sync_status: GitSyncStatus;
  token_usage: TokenUsage;
  workspace_ready: boolean;
}

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_cost_usd: number;
}

export interface PermissionRequest {
  id: string;
  tool_type: string;
  description: string;
  command: string;
  timestamp: string;
}

export interface OutputEntry {
  entry_type: OutputType;
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface AppConfig {
  anthropic_api_key: string | null;
  github_pat: string | null;
  github_username: string | null;
  default_mode: AgentMode;
  default_effort: EffortLevel;
  auto_push_on_complete: boolean;
  notifications_enabled: boolean;
  workspace_base_path: string;
  max_sessions: number;
  model: string;
  show_session_metadata: boolean;
  show_mode_badge: boolean;
  show_commit_badge: boolean;
  show_model_badge: boolean;
  show_usage_badge: boolean;
}

// --- Quick Prompts ---

export interface QuickPrompt {
  id: string;
  label: string;
  prompt: string;
}

// --- Nostr / DM Types ---

export type PanelMode = 'session' | 'dm';

export interface NostrConfig {
  private_key_hex: string | null;
  relays: string[];
  blossomServer?: string;
}

export interface DmConversation {
  id: string;
  participants: string[];
  display_name: string;
  last_message_at: string;
  unread_count: number;
}

/** Full NIP-01 kind-0 profile metadata, cached per pubkey. */
export interface ProfileMetadata {
  name?: string;
  displayName?: string;
  picture?: string;
  nip05?: string;
  about?: string;
  fetchedAt: number;
  status: 'ok' | 'notfound';
}

/** Transient UI status for an in-progress / failed profile resolution. */
export type ProfileStatus = 'loading' | 'ok' | 'error';

export interface DmMessage {
  id: string;
  conversation_id: string;
  sender_pubkey: string;
  content: string;
  timestamp: string;
  status: 'sent' | 'delivered' | 'failed';
}

// --- Remote Bridge Types ---

export interface AuthStatus {
  hasAnthropicKey: boolean;
  hasGithubPat: boolean;
  hasEnvKey: boolean;
}

export interface RemoteMachine {
  hostname: string;
  npub: string;
  pubkeyHex: string;
  relays: string[];
  connected: boolean;
  authStatus?: AuthStatus;
}

export interface RemoteSessionInfo {
  id: string;
  slug: string;
  cwd: string;
  lastActivity: string;
  lineCount: number;
  title: string | null;
  project: string;
  hasTerminal?: boolean;
  permissionMode?: AgentMode;
  effortLevel?: EffortLevel;
  model?: string;
  /** Real context-window size (tokens) the bridge's SDK resolved for this session — the honest
   *  denominator for the context-usage %. Present from protocol v4+ bridges once a result message
   *  has arrived; reflects the actual 1M-beta window when active. Falls back to model-id guessing
   *  when absent (older bridge or before first result). */
  contextWindow?: number;
  /** Authoritative context-usage % (0–100) the bridge read from the Agent SDK's
   *  `query.getContextUsage()` — the exact meter the Claude Code terminal shows. Present from
   *  protocol v5+ bridges (once a result has arrived). Preferred for display; falls back to the
   *  tokens/contextWindow computation when absent (older bridge or before first result). */
  contextPercentage?: number;
  committed?: boolean;
  state?: 'idle' | 'running' | 'waiting_permission' | 'waiting_question';
}

export interface RemoteOutputEntry {
  entryType: 'text' | 'tool_use' | 'tool_result' | 'system' | 'error' | 'progress';
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

// --- Subscription usage / rate-limit windows ---
// NOTE: these MUST stay byte-for-byte in sync with the bridge's copy in
// codedeck-bridge-vscode/src/types.ts (the two protocol type files are hand-mirrored).

/** A single claude.ai plan rate-limit window. `utilization` is 0-100; `resetsAt` is ISO 8601.
 *  Either may be null when the bridge reports the window but not its value. */
export interface UsageWindow {
  utilization: number | null;
  resetsAt: string | null;
}

/** Normalized subscription usage snapshot pushed by the bridge. */
export interface UsageData {
  /** False for API-key / Bedrock / Vertex sessions — phone hides the indicator entirely. */
  available: boolean;
  /** 'pro' | 'max' | 'team' | 'enterprise' or null. */
  subscriptionType: string | null;
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  sevenDayOpus?: UsageWindow;
  sevenDaySonnet?: UsageWindow;
  sessionCostUsd?: number;
  /** ISO timestamp (bridge clock) of when this snapshot was fetched. */
  fetchedAt: string;
}

// --- GSD workflow state ---

/**
 * One roadmap phase. `diskStatus` is GSD's own vocabulary, mapped to the Discuss/Plan/Execute
 * stage triple by `gsdStages.ts`:
 *   complete | executed | partial | planned | discussed | researched | empty | no_directory
 */
export interface GsdPhase {
  number: string;
  name: string;
  diskStatus: string;
  plans: number;
  summaries: number;
  /** GSD's `is_active`: a file in the phase dir changed <5 min ago. NOT agent liveness. */
  recentlyTouched: boolean;
  /** Per-phase next step, e.g. 'execute' — null when GSD recommends nothing for this phase. */
  action: string | null;
  /** Ready-to-send slash command for that step, e.g. '/gsd-execute-phase 2'. */
  command: string | null;
  /** Total plans in the phase. null = GSD wasn't asked (nothing to execute here). */
  planCount: number | null;
  /** Plans that will BLOCK on a human — the pre-flight cost of tapping this. null = not computed. */
  needsYou: number | null;
}

/** Live progress inside a running phase, reconstructed from GSD's atomic task commits. */
export interface GsdExecution {
  phase: string;
  plansTotal: number;
  plansDone: number;
  currentPlan: string | null;
  tasksDone: number;
  tasksTotal: number | null;
  lastTask: string | null;
}

/** A workflow-level action the phone fires by sending `command` as ordinary session input. */
export interface GsdAction {
  id: string;
  label: string;
  command: string;
  recommended: boolean;
}

/** Snapshot of a session's GSD position. */
export interface GsdState {
  /** GSD exists on the laptop. Distinct from `available`: only `installed && !available`
   *  can offer a Start button — otherwise there is nothing to start it with. */
  installed: boolean;
  /** This project has a `.planning/` directory, i.e. real workflow state to show. */
  available: boolean;
  /** no-project | needs-first-phase | planning | executing | verify-pending | … */
  situation: string;
  summary: string;
  milestone: string | null;
  currentPhase: string | null;
  totalPhases: number | null;
  percent: number;
  phases: GsdPhase[];
  actions: GsdAction[];
  /** id of the recommended entry in `actions`. */
  recommended: string | null;
  paused: boolean;
  blockers: string[];
  verifyFailed: boolean;
  execution: GsdExecution | null;
}

export type BridgeInboundMessage =
  | { type: 'sessions'; machine: string; sessions: RemoteSessionInfo[]; authStatus?: AuthStatus; protocolVersion?: number }
  | { type: 'output'; sessionId: string; seq: number; entry: RemoteOutputEntry }
  | { type: 'history'; sessionId: string; entries: Array<{ seq: number; entry: RemoteOutputEntry }>; totalEntries: number; fromSeq: number; toSeq: number; chunkIndex?: number; totalChunks?: number; requestId?: string }
  | { type: 'session-pending'; pendingId: string; machine: string; createdAt: string }
  | { type: 'session-ready'; pendingId: string; session: RemoteSessionInfo }
  | { type: 'session-failed'; pendingId: string; reason: string }
  | { type: 'input-failed'; sessionId: string; reason: 'no-terminal' | 'expired' }
  | { type: 'close-session-ack'; sessionId: string; success: boolean }
  | { type: 'session-replaced'; oldSessionId: string; newSession: RemoteSessionInfo }
  | { type: 'mode-confirmed'; sessionId: string; mode: AgentMode }
  | { type: 'effort-confirmed'; sessionId: string; level: EffortLevel }
  | { type: 'model-confirmed'; sessionId: string; model: string }
  | { type: 'usage'; sessionId: string; usage: UsageData }
  | { type: 'gsd-state'; sessionId: string; gsd: GsdState }
  | { type: 'credentials-ack'; machine: string; success: boolean; hasAnthropicKey: boolean; hasGithubPat: boolean; keyValid?: boolean; error?: string }
  | { type: 'pair-ack'; machine: string; ok: boolean; reason?: string };

export type BridgeOutboundMessage =
  | { type: 'input'; sessionId: string; text: string }
  | { type: 'question-input'; sessionId: string; text: string; optionCount: number }
  | { type: 'permission-res'; sessionId: string; requestId: string; allow: boolean; modifier?: 'always' | 'never' }
  | { type: 'keypress'; sessionId: string; key: string; context?: 'plan-approval' | 'exit-plan' | 'question' }
  | { type: 'mode'; sessionId: string; mode: AgentMode }
  | { type: 'effort'; sessionId: string; level: EffortLevel }
  | { type: 'model'; sessionId: string; model: string }
  | { type: 'usage-request'; sessionId: string }
  | { type: 'gsd-request'; sessionId: string }
  | { type: 'history-request'; sessionId: string; afterSeq?: number }
  | { type: 'create-session'; defaultEffort?: EffortLevel; model?: string; testSession?: boolean }
  | { type: 'refresh-sessions' }
  | { type: 'interrupt'; sessionId: string }
  | { type: 'close-session'; sessionId: string }
  | { type: 'upload-image'; sessionId: string; uploadId: string; filename: string; mimeType: string; base64Data: string; text: string; chunkIndex: number; totalChunks: number }
  | { type: 'upload-image'; sessionId: string; hash: string; url: string; key: string; iv: string; filename: string; mimeType: string; text: string; sizeBytes: number }
  | { type: 'set-credentials'; anthropicApiKey?: string | null; githubPat?: string | null }
  | { type: 'set-device-config'; config: DeviceConfig }
  | { type: 'pair-request'; npub: string; pubkeyHex: string; label: string; token: string };

/**
 * Test-device configuration the phone sends to the bridge. Tells the laptop which device to
 * target over the mesh and how to build the app under test. Persisted on the bridge in globalState.
 */
export interface DeviceConfig {
  /** Friendly label shown in the UI. */
  label: string;
  /** Device role. A 'test-target' phone is auto-authorized on the mesh by the bridge and its adb
   *  serial is derived bridge-side from its pubkey. Absent/'controller' = a normal control phone. */
  role?: 'controller' | 'test-target';
  /** adb serial — the device's mesh IP:port (e.g. "10.44.12.34:5555"), or a USB serial in setup.
   *  Optional: a 'test-target' phone reports its real mesh IP via `meshIp` instead and the bridge
   *  builds the serial from that. */
  serial?: string;
  /** The phone's REAL mesh tunnel IP (e.g. "10.44.126.167"), read from the mesh engine's own state.
   *  The mesh VpnService has its own key (separate from the app/bridge key), so the bridge cannot
   *  derive this from the pairing pubkey — the phone is the source of truth. */
  meshIp?: string;
  /** The phone's MESH-engine pubkey (hex) — the identity the bridge must authorize on the mesh
   *  roster (`add-participant`). Distinct from the bridge-pairing pubkey. */
  meshPubkey?: string;
  /** Which app the autonomous test loop builds & installs. */
  appUnderTest: 'kubo' | 'veil' | 'custom';
  /** For 'custom': the package id to launch (e.g. com.example.dev). */
  customPackage?: string;
  /** For 'custom': the shell build command (run in the project dir) that produces an APK. */
  customBuildCmd?: string;
  /** Absolute path to the project dir for the app under test (defaults to the bridge workspace). */
  projectDir?: string;
}

/** Bridge ack after storing a device config (mirrors CredentialsAckMessage). */
export interface DeviceConfigAck {
  type: 'device-config-ack';
  success: boolean;
  /** Whether the configured device is currently reachable via `adb devices`. */
  reachable?: boolean;
  error?: string;
}
