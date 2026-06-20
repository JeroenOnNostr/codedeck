import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * notifyIfNeeded fires the in-app audible ping. We mock pingSound so we can assert the
 * ping is played independently of OS-notification permission (which starts ungranted —
 * initNotifications() is never called here). Re-import per test so the module-level
 * cooldown map starts empty. The `mock` prefix lets vi.mock's hoisted factory close over it.
 */
const mockPlayPing = vi.fn();
vi.mock('../services/pingSound', () => ({
  playAttentionPing: (...args: unknown[]) => mockPlayPing(...args),
  initPingAudio: vi.fn(),
}));

async function loadService() {
  vi.resetModules();
  return import('../services/notificationService');
}

describe('notificationService.notifyIfNeeded', () => {
  beforeEach(() => {
    mockPlayPing.mockClear();
  });

  it('plays the audible ping even when OS notification permission is not granted', async () => {
    // permissionGranted defaults to false (initNotifications not called) — the old code
    // returned before the ping; the ping must now still fire on mobile.
    const svc = await loadService();
    svc.notifyIfNeeded({ sessionId: 's1', activeSessionId: 's2', type: 'session_complete' });
    expect(mockPlayPing).toHaveBeenCalledTimes(1);
  });

  it('does not ping for the session the user is viewing in the foreground', async () => {
    const svc = await loadService();
    svc.setAppHidden(false);
    svc.notifyIfNeeded({ sessionId: 's1', activeSessionId: 's1', type: 'session_complete' });
    expect(mockPlayPing).not.toHaveBeenCalled();
  });

  it('dedups repeated pings for the same session+type within the cooldown', async () => {
    const svc = await loadService();
    svc.notifyIfNeeded({ sessionId: 's1', activeSessionId: 's2', type: 'permission_request' });
    svc.notifyIfNeeded({ sessionId: 's1', activeSessionId: 's2', type: 'permission_request' });
    expect(mockPlayPing).toHaveBeenCalledTimes(1);
  });
});
