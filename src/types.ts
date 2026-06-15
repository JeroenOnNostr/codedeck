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
  committed?: boolean;
  state?: 'idle' | 'running' | 'waiting_permission' | 'waiting_question';
}

export interface RemoteOutputEntry {
  entryType: 'text' | 'tool_use' | 'tool_result' | 'system' | 'error' | 'progress';
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
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
  | { type: 'credentials-ack'; machine: string; success: boolean; hasAnthropicKey: boolean; hasGithubPat: boolean; keyValid?: boolean; error?: string };

export type BridgeOutboundMessage =
  | { type: 'input'; sessionId: string; text: string }
  | { type: 'question-input'; sessionId: string; text: string; optionCount: number }
  | { type: 'permission-res'; sessionId: string; requestId: string; allow: boolean; modifier?: 'always' | 'never' }
  | { type: 'keypress'; sessionId: string; key: string; context?: 'plan-approval' | 'exit-plan' | 'question' }
  | { type: 'mode'; sessionId: string; mode: AgentMode }
  | { type: 'effort'; sessionId: string; level: EffortLevel }
  | { type: 'model'; sessionId: string; model: string }
  | { type: 'history-request'; sessionId: string; afterSeq?: number }
  | { type: 'create-session'; defaultEffort?: EffortLevel; model?: string }
  | { type: 'refresh-sessions' }
  | { type: 'interrupt'; sessionId: string }
  | { type: 'close-session'; sessionId: string }
  | { type: 'upload-image'; sessionId: string; uploadId: string; filename: string; mimeType: string; base64Data: string; text: string; chunkIndex: number; totalChunks: number }
  | { type: 'upload-image'; sessionId: string; hash: string; url: string; key: string; iv: string; filename: string; mimeType: string; text: string; sizeBytes: number }
  | { type: 'set-credentials'; anthropicApiKey?: string | null; githubPat?: string | null };
