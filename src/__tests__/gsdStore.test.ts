import { describe, it, expect, beforeEach } from 'vitest';
import { useSessionStore } from '../stores/sessionStore';
import type { GsdState } from '../types';

function gsd(overrides: Partial<GsdState> = {}): GsdState {
  return {
    installed: true,
    available: true,
    situation: 'executing',
    summary: 'Executing phase 2',
    milestone: 'v1.0 — MVP',
    currentPhase: '2',
    totalPhases: 3,
    percent: 50,
    phases: [],
    actions: [],
    recommended: null,
    paused: false,
    blockers: [],
    verifyFailed: false,
    execution: null,
    ...overrides,
  };
}

describe('sessionStore — GSD snapshots', () => {
  beforeEach(() => {
    useSessionStore.setState({ remoteSessionGsd: {}, remoteSessions: {}, outputs: {} });
  });

  it('starts empty so the strip is hidden until a bridge answers', () => {
    expect(useSessionStore.getState().remoteSessionGsd['s1']).toBeUndefined();
  });

  it('holds a per-session snapshot without leaking across sessions', () => {
    useSessionStore.setState({
      remoteSessionGsd: { s1: gsd({ currentPhase: '2' }), s2: gsd({ currentPhase: '7' }) },
    });
    const s = useSessionStore.getState().remoteSessionGsd;
    expect(s['s1'].currentPhase).toBe('2');
    expect(s['s2'].currentPhase).toBe('7');
  });

  it('stores an unavailable snapshot so a session leaving GSD retires its strip', () => {
    // The bridge answers `available: false` rather than staying silent — that is the signal that
    // turns the strip OFF. Dropping it would leave a stale roadmap pinned forever.
    useSessionStore.setState({ remoteSessionGsd: { s1: gsd() } });
    useSessionStore.setState({
      remoteSessionGsd: { ...useSessionStore.getState().remoteSessionGsd, s1: gsd({ available: false }) },
    });
    expect(useSessionStore.getState().remoteSessionGsd['s1'].available).toBe(false);
  });

  it('clears the snapshot when the session is deleted', () => {
    useSessionStore.setState({ remoteSessionGsd: { s1: gsd(), s2: gsd() } });
    useSessionStore.getState().deleteRemoteSession('s1');
    const s = useSessionStore.getState().remoteSessionGsd;
    expect(s['s1']).toBeUndefined();
    expect(s['s2']).toBeDefined();
  });

  it('refreshGsd is a no-op when the session has no paired machine', async () => {
    await expect(useSessionStore.getState().refreshGsd('unknown-session')).resolves.toBeUndefined();
  });
});
