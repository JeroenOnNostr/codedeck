import type { Session, OutputEntry, AppConfig, AgentMode, TokenUsage } from '../types';

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
type ListenFn = (event: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>;

let _invoke: InvokeFn | null = null;
let _listen: ListenFn | null = null;
let _initialized = false;

async function init(): Promise<void> {
  if (_initialized) return;
  _initialized = true;

  // Check if we're actually inside a Tauri webview, not just whether the npm package exists
  if (!('__TAURI_INTERNALS__' in window)) {
    console.log('Running outside Tauri — mock mode enabled');
    return;
  }

  try {
    const core = await import('@tauri-apps/api/core');
    _invoke = core.invoke as InvokeFn;
    const event = await import('@tauri-apps/api/event');
    _listen = event.listen as ListenFn;
  } catch {
    console.log('Tauri API import failed — mock mode enabled');
  }
}

export function isTauri(): boolean {
  // Synchronous check — works before init() has been called
  return '__TAURI_INTERNALS__' in window;
}

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  await init();
  if (!_invoke) return null;
  return await _invoke(cmd, args) as T;
}

export async function listen(event: string, handler: (payload: unknown) => void): Promise<() => void> {
  await init();
  if (!_listen) return () => {};
  const unlisten = await _listen(event, (e) => handler(e.payload));
  return unlisten;
}

// Typed command wrappers
export const api = {
  getSessions: () => invoke<Session[]>('get_sessions'),
  createSession: (name: string, group: string, repoUrl: string, branch: string) =>
    invoke<Session>('create_session', { name, group, repoUrl, branch }),
  deleteSession: (sessionId: string) => invoke('delete_session', { sessionId }),
  sendMessage: (sessionId: string, text: string) => invoke('send_message', { sessionId, text }),
  cancelAgent: (sessionId: string) => invoke('cancel_agent', { sessionId }),
  respondPermission: (sessionId: string, requestId: string, allow: boolean) =>
    invoke('respond_permission', { sessionId, requestId, allow }),
  setMode: (sessionId: string, mode: AgentMode) => invoke('set_mode', { sessionId, mode }),
  gitPush: (sessionId: string) => invoke<string>('git_push', { sessionId }),
  gitPull: (sessionId: string) => invoke<string>('git_pull', { sessionId }),
  getConfig: () => invoke<AppConfig>('get_config'),
  updateConfig: (config: AppConfig) => invoke('update_config', { config }),
};

// Event listeners
export const events = {
  onSessionOutput: (handler: (data: { session_id: string; entry: OutputEntry }) => void) =>
    listen('session-output', handler as (p: unknown) => void),
  onSessionState: (handler: (data: { session_id: string; state: string; session: Session }) => void) =>
    listen('session-state', handler as (p: unknown) => void),
  onPermissionRequest: (handler: (data: { session_id: string; request: unknown }) => void) =>
    listen('permission-request', handler as (p: unknown) => void),
  onTokenUsage: (handler: (data: { session_id: string; usage: TokenUsage }) => void) =>
    listen('token-usage', handler as (p: unknown) => void),
};
