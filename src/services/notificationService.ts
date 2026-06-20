/**
 * Notification service — sends OS-level notifications when the app is
 * backgrounded and Claude needs attention (permission, question, plan approval).
 *
 * Uses @tauri-apps/plugin-notification on Android/desktop.
 * Falls back to the Web Notification API in browser mock mode.
 */

import { playAttentionPing } from './pingSound';

let tauriNotification: typeof import('@tauri-apps/plugin-notification') | null = null;
let permissionGranted = false;
let initialized = false;

/** Whether the app is currently in the background (document hidden). */
let appHidden = false;

/** Track which notification types we've recently sent to avoid spam. */
const recentNotifications = new Map<string, number>();
const COOLDOWN_MS = 10_000; // Don't re-notify for same session+type within 10s

export function setAppHidden(hidden: boolean) {
  appHidden = hidden;
}

/** Initialize the notification system. Call once at app startup. */
export async function initNotifications(): Promise<void> {
  if (initialized) return;
  initialized = true;

  try {
    tauriNotification = await import('@tauri-apps/plugin-notification');
    permissionGranted = await tauriNotification.isPermissionGranted();
    if (!permissionGranted) {
      const result = await tauriNotification.requestPermission();
      permissionGranted = result === 'granted';
    }
  } catch {
    // Not in Tauri context (browser mock mode) — try Web Notification API
    if ('Notification' in window) {
      if (Notification.permission === 'granted') {
        permissionGranted = true;
      } else if (Notification.permission !== 'denied') {
        const result = await Notification.requestPermission();
        permissionGranted = result === 'granted';
      }
    }
  }
}

/**
 * Send a notification if the app is backgrounded or the session is not active.
 * Deduplicates by session+type within COOLDOWN_MS.
 */
export function notifyIfNeeded(opts: {
  sessionId: string;
  activeSessionId: string | null;
  type: 'permission_request' | 'plan_approval' | 'ask_question' | 'session_complete';
  toolName?: string;
}) {
  // Only notify when app is hidden or user is viewing a different session
  if (!appHidden && opts.activeSessionId === opts.sessionId) return;

  // Cooldown dedup
  const key = `${opts.sessionId}:${opts.type}`;
  const now = Date.now();
  const last = recentNotifications.get(key);
  if (last && now - last < COOLDOWN_MS) return;
  recentNotifications.set(key, now);

  // Clean old entries periodically
  if (recentNotifications.size > 50) {
    for (const [k, t] of recentNotifications) {
      if (now - t > COOLDOWN_MS) recentNotifications.delete(k);
    }
  }

  // Audible chime — pure in-app Web Audio, so it works on mobile even when the OS
  // notification permission was never granted. Plays on every needs-attention event
  // (blocked or task complete), independent of the OS notification below.
  playAttentionPing();

  // OS notification requires permission (Android prompt / desktop). Skip if not granted.
  if (!permissionGranted) return;
  const { title, body } = formatNotification(opts.type, opts.toolName);
  sendOsNotification(title, body);
}

function formatNotification(
  type: string,
  toolName?: string,
): { title: string; body: string } {
  switch (type) {
    case 'permission_request':
      return {
        title: 'Permission Required',
        body: toolName ? `Claude wants to use ${toolName}` : 'Claude needs permission to proceed',
      };
    case 'plan_approval':
      return {
        title: 'Plan Ready for Review',
        body: 'Claude has a plan that needs your approval',
      };
    case 'ask_question':
      return {
        title: 'Question from Claude',
        body: 'Claude is asking you a question',
      };
    case 'session_complete':
      return {
        title: 'Session Complete',
        body: 'Claude has finished the task',
      };
    default:
      return { title: 'Codedeck', body: 'Claude needs your attention' };
  }
}

function sendOsNotification(title: string, body: string) {
  if (tauriNotification) {
    tauriNotification.sendNotification({ title, body });
  } else if ('Notification' in window && permissionGranted) {
    new Notification(title, { body });
  }
}
