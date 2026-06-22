import { Session, RemoteSessionInfo } from '../types';

/**
 * Single source of truth for "this session wants the user's attention now."
 *
 * True when the session is blocked on the user (plan/permission approval or an
 * AskUserQuestion) OR has unread activity the user hasn't looked at.
 *
 * The waiting branch is independent of `isUnread`, so a session blocked on the
 * user lights up even while it's the foreground/active session — the unread
 * mechanism deliberately skips the foreground session, but the dot must not.
 *
 * `state` accepts both the local `SessionState` (which has no 'waiting_question')
 * and the remote `RemoteSessionInfo['state']`; the extra branch is simply never
 * true for local sessions, so it's harmless there.
 */
export function sessionNeedsAttention(
  state: Session['state'] | RemoteSessionInfo['state'] | undefined,
  isUnread: boolean,
): boolean {
  return state === 'waiting_permission' || state === 'waiting_question' || isUnread;
}
