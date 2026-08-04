import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  useSessionStore,
  adoptOptimisticSession,
  isLocalPlaceholder,
  fireGsdKickoff,
  cancelGsdKickoff,
} from '../stores/sessionStore';
import {
  sanitizeProjectFolder,
  orderProjectFolders,
  resolveProjectFolder,
  PROJECT_FOLDER_CUSTOM,
} from '../components/NewSessionModal';
import { OutputEntry, RemoteMachine, RemoteSessionInfo } from '../types';

function makeEntry(overrides: Partial<OutputEntry> = {}): OutputEntry {
  return {
    entry_type: 'message',
    content: 'test content',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('sessionStore.addOutput', () => {
  const sessionId = 'test-session';

  beforeEach(() => {
    // Reset the store between tests
    useSessionStore.setState({ outputs: {}, sessions: [], activeSessionId: null });
  });

  it('creates a new entry for non-streaming output', () => {
    const store = useSessionStore.getState();
    store.addOutput(sessionId, makeEntry({ content: 'hello' }));

    const outputs = useSessionStore.getState().outputs[sessionId];
    expect(outputs).toHaveLength(1);
    expect(outputs[0].content).toBe('hello');
  });

  it('creates multiple entries for non-streaming outputs', () => {
    const store = useSessionStore.getState();
    store.addOutput(sessionId, makeEntry({ content: 'first' }));
    store.addOutput(sessionId, makeEntry({ content: 'second' }));

    const outputs = useSessionStore.getState().outputs[sessionId];
    expect(outputs).toHaveLength(2);
    expect(outputs[0].content).toBe('first');
    expect(outputs[1].content).toBe('second');
  });

  it('appends streaming content to last message entry', () => {
    const store = useSessionStore.getState();
    // First chunk creates the entry
    store.addOutput(sessionId, makeEntry({
      content: 'Hello ',
      metadata: { streaming: true },
    }));
    // Second chunk appends to it
    store.addOutput(sessionId, makeEntry({
      content: 'world!',
      metadata: { streaming: true },
    }));

    const outputs = useSessionStore.getState().outputs[sessionId];
    expect(outputs).toHaveLength(1);
    expect(outputs[0].content).toBe('Hello world!');
  });

  it('does not append streaming to non-message entry', () => {
    const store = useSessionStore.getState();
    // First entry is an action, not a message
    store.addOutput(sessionId, makeEntry({
      entry_type: 'action',
      content: 'Read: file.rs',
    }));
    // Streaming message should create a new entry, not append to action
    store.addOutput(sessionId, makeEntry({
      content: 'response text',
      metadata: { streaming: true },
    }));

    const outputs = useSessionStore.getState().outputs[sessionId];
    expect(outputs).toHaveLength(2);
    expect(outputs[0].entry_type).toBe('action');
    expect(outputs[1].entry_type).toBe('message');
  });

  it('filters out stream_end markers', () => {
    const store = useSessionStore.getState();
    store.addOutput(sessionId, makeEntry({ content: 'hello' }));
    store.addOutput(sessionId, makeEntry({
      entry_type: 'system',
      content: '',
      metadata: { stream_end: true },
    }));

    const outputs = useSessionStore.getState().outputs[sessionId];
    expect(outputs).toHaveLength(1);
    expect(outputs[0].content).toBe('hello');
  });

  it('caps output at 5000 entries', () => {
    // Add 5000 entries
    const entries: OutputEntry[] = [];
    for (let i = 0; i < 5000; i++) {
      entries.push(makeEntry({ content: `msg-${i}` }));
    }
    useSessionStore.setState({
      outputs: { [sessionId]: entries },
    });

    // Add one more — should drop the oldest
    useSessionStore.getState().addOutput(sessionId, makeEntry({ content: 'overflow' }));

    const outputs = useSessionStore.getState().outputs[sessionId];
    expect(outputs).toHaveLength(5000);
    // First entry should now be msg-1 (msg-0 was dropped)
    expect(outputs[0].content).toBe('msg-1');
    // Last entry should be the overflow
    expect(outputs[outputs.length - 1].content).toBe('overflow');
  });

  it('handles output for unknown session gracefully', () => {
    const store = useSessionStore.getState();
    store.addOutput('nonexistent', makeEntry({ content: 'hello' }));

    const outputs = useSessionStore.getState().outputs['nonexistent'];
    expect(outputs).toHaveLength(1);
  });
});

describe('sessionStore unread dot', () => {
  const sessionId = 'unread-session';

  function setVisibility(value: 'visible' | 'hidden') {
    Object.defineProperty(document, 'visibilityState', { value, configurable: true });
  }

  beforeEach(() => {
    useSessionStore.setState({
      outputs: {},
      sessions: [],
      activeSessionId: null,
      unreadSessions: new Set(),
      historyLoading: {},
    });
    setVisibility('visible');
  });

  it('clears the unread dot when a session becomes active (app visible)', () => {
    useSessionStore.setState({ unreadSessions: new Set([sessionId]) });
    useSessionStore.getState().setActiveSession(sessionId);
    expect(useSessionStore.getState().unreadSessions.has(sessionId)).toBe(false);
  });

  it('does NOT clear the unread dot on setActiveSession while app is hidden', () => {
    setVisibility('hidden');
    useSessionStore.setState({ unreadSessions: new Set([sessionId]) });
    useSessionStore.getState().setActiveSession(sessionId);
    expect(useSessionStore.getState().unreadSessions.has(sessionId)).toBe(true);
  });

  it('does NOT mark the actively-watched (visible) session on stream_end', () => {
    useSessionStore.setState({ activeSessionId: sessionId });
    useSessionStore.getState().addOutput(sessionId, makeEntry({
      entry_type: 'system', content: '', metadata: { stream_end: true },
    }));
    expect(useSessionStore.getState().unreadSessions.has(sessionId)).toBe(false);
  });

  it('marks a non-active session on stream_end', () => {
    useSessionStore.setState({ activeSessionId: 'other-session' });
    useSessionStore.getState().addOutput(sessionId, makeEntry({
      entry_type: 'system', content: '', metadata: { stream_end: true },
    }));
    expect(useSessionStore.getState().unreadSessions.has(sessionId)).toBe(true);
  });

  it('marks the active session on stream_end when app is hidden', () => {
    setVisibility('hidden');
    useSessionStore.setState({ activeSessionId: sessionId });
    useSessionStore.getState().addOutput(sessionId, makeEntry({
      entry_type: 'system', content: '', metadata: { stream_end: true },
    }));
    expect(useSessionStore.getState().unreadSessions.has(sessionId)).toBe(true);
  });

  it('marks a non-active session on an interactive (needs-input) entry', () => {
    useSessionStore.setState({ activeSessionId: 'other-session' });
    useSessionStore.getState().addOutput(sessionId, makeEntry({
      entry_type: 'system', content: 'Permission needed',
      metadata: { special: 'permission_request' },
    }));
    expect(useSessionStore.getState().unreadSessions.has(sessionId)).toBe(true);
  });

  it('does not mark unread while replaying history', () => {
    useSessionStore.setState({ activeSessionId: 'other-session', historyLoading: { [sessionId]: true } });
    useSessionStore.getState().addOutput(sessionId, makeEntry({
      entry_type: 'system', content: 'Permission needed',
      metadata: { special: 'permission_request' },
    }));
    expect(useSessionStore.getState().unreadSessions.has(sessionId)).toBe(false);
  });

  it('clears the unread dot when the agent resumes producing output', () => {
    // A new turn started: ordinary output means the agent is working, not waiting on us.
    useSessionStore.setState({ activeSessionId: 'other-session', unreadSessions: new Set([sessionId]) });
    useSessionStore.getState().addOutput(sessionId, makeEntry({
      entry_type: 'action', content: 'Read: file.rs',
    }));
    expect(useSessionStore.getState().unreadSessions.has(sessionId)).toBe(false);
  });

  it('clears a stream_end-marked dot once the agent runs more actions', () => {
    // Regression: the dot must not persist while a session is actively running.
    useSessionStore.setState({ activeSessionId: 'other-session' });
    const store = useSessionStore.getState();
    store.addOutput(sessionId, makeEntry({
      entry_type: 'system', content: '', metadata: { stream_end: true },
    }));
    expect(useSessionStore.getState().unreadSessions.has(sessionId)).toBe(true);
    store.addOutput(sessionId, makeEntry({ entry_type: 'message', content: 'next turn' }));
    expect(useSessionStore.getState().unreadSessions.has(sessionId)).toBe(false);
  });

  it('still marks unread on a card entry even after working output cleared it', () => {
    useSessionStore.setState({ activeSessionId: 'other-session' });
    const store = useSessionStore.getState();
    store.addOutput(sessionId, makeEntry({ entry_type: 'message', content: 'working...' }));
    expect(useSessionStore.getState().unreadSessions.has(sessionId)).toBe(false);
    store.addOutput(sessionId, makeEntry({
      entry_type: 'system', content: 'Plan ready',
      metadata: { special: 'plan_approval' },
    }));
    expect(useSessionStore.getState().unreadSessions.has(sessionId)).toBe(true);
  });
});

// Optimistic session start: tapping "Start Session" must open a usable session view
// instantly (active + input enabled), buffer a first message typed before the bridge
// answers, and reconcile the placeholder into the real session in place when session-ready
// arrives — flushing the buffered message. These tests lock in that flow.
describe('sessionStore optimistic session start', () => {
  const machine = {
    hostname: 'testbox',
    pubkeyHex: 'machinepubkey',
    relays: [],
    connected: true,
  } as unknown as RemoteMachine;

  beforeEach(() => {
    useSessionStore.setState({
      machines: [machine],
      remoteSessions: {},
      outputs: {},
      activeSessionId: null,
      optimisticSessions: new Map(),
      optimisticQueueByMachine: new Map(),
      remoteSessionModel: {},
      remoteSessionEffort: {},
      remoteSessionModes: {},
      unreadSessions: new Set(),
      sessionReadyTimestamps: new Map(),
    });
  });

  afterEach(() => {
    // Clear any armed no-ack timers so they don't keep the worker alive.
    for (const opt of useSessionStore.getState().optimisticSessions.values()) {
      clearTimeout(opt.timeoutId);
    }
  });

  it('isLocalPlaceholder flags pending: and optimistic: ids', () => {
    expect(isLocalPlaceholder('pending:abc')).toBe(true);
    expect(isLocalPlaceholder('optimistic:abc')).toBe(true);
    expect(isLocalPlaceholder('real-session-id')).toBe(false);
  });

  it('opens an active, non-offline optimistic session immediately on start', () => {
    useSessionStore.getState().startOptimisticRemoteSession(machine, { model: 'claude-opus-4-8' });

    const state = useSessionStore.getState();
    const activeId = state.activeSessionId!;
    expect(activeId.startsWith('optimistic:')).toBe(true);

    const rows = state.remoteSessions[machine.pubkeyHex];
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(activeId);
    expect(rows[0].state).toBe('running');

    // The bridge owns this machine and it's connected → input is NOT gated offline.
    expect(state.isBridgeOffline(activeId)).toBe(false);
    // Model pill is seeded from the first frame.
    expect(state.remoteSessionModel[activeId]).toBe('claude-opus-4-8');
    // Tracked for adoption.
    expect(state.optimisticQueueByMachine.get(machine.pubkeyHex)).toHaveLength(1);
  });

  it('buffers a first message typed before the session is ready (no throw, echoed locally)', () => {
    useSessionStore.getState().startOptimisticRemoteSession(machine, { model: 'claude-opus-4-8' });
    const activeId = useSessionStore.getState().activeSessionId!;
    const localId = activeId.slice('optimistic:'.length);

    useSessionStore.getState().sendMessage(activeId, 'first message');

    const state = useSessionStore.getState();
    // Echoed locally so the user sees their message.
    const echoed = state.outputs[activeId].find(e => e.entry_type === 'user_message');
    expect(echoed?.content).toBe('first message');
    // Buffered for flush on adoption.
    expect(state.optimisticSessions.get(localId)?.bufferedMessages).toHaveLength(1);
    // Title derived from the first message.
    expect(state.remoteSessions[machine.pubkeyHex][0].title).toBe('first message');
  });

  it('adopts the real session in place, migrating outputs + active selection, preserving the title', () => {
    useSessionStore.getState().startOptimisticRemoteSession(machine, { model: 'claude-opus-4-8' });
    const activeId = useSessionStore.getState().activeSessionId!;
    const localId = activeId.slice('optimistic:'.length);
    useSessionStore.getState().sendMessage(activeId, 'do the thing');

    const realSession: RemoteSessionInfo = {
      id: 'real-session-123',
      slug: 'session-real',
      cwd: '/work/proj',
      lastActivity: new Date().toISOString(),
      lineCount: 0,
      title: null, // bridge doesn't know the title yet
      project: 'proj',
    };
    adoptOptimisticSession(localId, realSession, useSessionStore.setState, useSessionStore.getState);

    const state = useSessionStore.getState();
    const rows = state.remoteSessions[machine.pubkeyHex];
    // Single row, now carrying the real id (rewritten in place — no duplicate card).
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('real-session-123');
    // User's first-message title preserved over the bridge's null.
    expect(rows[0].title).toBe('do the thing');
    // Active selection followed the swap.
    expect(state.activeSessionId).toBe('real-session-123');
    // Outputs migrated to the real id; optimistic id cleaned up.
    expect(state.outputs['real-session-123']?.some(e => e.content === 'do the thing')).toBe(true);
    expect(state.outputs[activeId]).toBeUndefined();
    // Bookkeeping cleared.
    expect(state.optimisticSessions.has(localId)).toBe(false);
    expect(state.optimisticQueueByMachine.get(machine.pubkeyHex)).toHaveLength(0);
  });

  it('retry re-arms a failed optimistic session back to starting', () => {
    useSessionStore.getState().startOptimisticRemoteSession(machine, { model: 'claude-opus-4-8' });
    const activeId = useSessionStore.getState().activeSessionId!;
    const localId = activeId.slice('optimistic:'.length);

    // Simulate a failure flip (as onSessionFailed / the no-ack timeout would do).
    const opt = useSessionStore.getState().optimisticSessions.get(localId)!;
    clearTimeout(opt.timeoutId);
    useSessionStore.setState({
      optimisticSessions: new Map([[localId, { ...opt, status: 'failed' }]]),
      optimisticQueueByMachine: new Map([[machine.pubkeyHex, []]]),
    });
    expect(useSessionStore.getState().optimisticSessions.get(localId)?.status).toBe('failed');

    useSessionStore.getState().retryOptimisticSession(localId);

    const state = useSessionStore.getState();
    expect(state.optimisticSessions.get(localId)?.status).toBe('starting');
    expect(state.optimisticQueueByMachine.get(machine.pubkeyHex)).toContain(localId);
  });
});

/**
 * CD-058 — "Start a new GSD project" from the phone.
 *
 * Two ordering rules carry the whole feature, and both are invisible if you only look at the UI:
 *
 *  1. The command may not go out while the session is still in plan mode. GSD's workflows WRITE —
 *     in plan mode Claude Code plans them instead of running them, which looks identical to the
 *     button doing nothing. So the mode change goes first and the command waits for its confirm.
 *  2. The strip must be opted in the moment the session exists, not when `.planning/` appears —
 *     otherwise it is hidden for the entire interview, i.e. exactly when it is wanted.
 */
describe('sessionStore — GSD project kickoff', () => {
  const machine = {
    hostname: 'testbox',
    pubkeyHex: 'machinepubkey',
    relays: [],
    connected: true,
  } as unknown as RemoteMachine;

  const realSession = (id = 'real-gsd-1'): RemoteSessionInfo => ({
    id,
    slug: 'session-real',
    cwd: '/ws/my-app',
    lastActivity: new Date().toISOString(),
    lineCount: 0,
    title: null,
    project: 'my-app',
  });

  let sent: Array<[string, string]>;
  let modes: Array<[string, string]>;

  beforeEach(() => {
    sent = [];
    modes = [];
    useSessionStore.setState({
      machines: [machine],
      remoteSessions: {},
      outputs: {},
      activeSessionId: null,
      optimisticSessions: new Map(),
      optimisticQueueByMachine: new Map(),
      remoteSessionModes: {},
      gsdEnabledSessions: {},
      sessionReadyTimestamps: new Map(),
      unreadSessions: new Set(),
      sendMessage: (async (id: string, text: string) => { sent.push([id, text]); }) as never,
      setMode: (async (id: string, mode: string) => { modes.push([id, mode]); }) as never,
      setGsdEnabled: ((id: string, on: boolean) => {
        useSessionStore.setState((s) => ({ gsdEnabledSessions: { ...s.gsdEnabledSessions, [id]: on } }));
      }) as never,
    });
  });

  afterEach(() => {
    for (const opt of useSessionStore.getState().optimisticSessions.values()) clearTimeout(opt.timeoutId);
    cancelGsdKickoff('real-gsd-1');
  });

  function startGsdSession() {
    useSessionStore.getState().startOptimisticRemoteSession(machine, {
      cwd: 'my-app',
      createCwd: true,
      gsd: { command: '/gsd-new-project', mode: 'default' },
    });
    const activeId = useSessionStore.getState().activeSessionId!;
    return activeId.slice('optimistic:'.length);
  }

  it('switches mode first and holds the command until the bridge confirms', () => {
    const localId = startGsdSession();
    adoptOptimisticSession(localId, realSession(), useSessionStore.setState, useSessionStore.getState);

    // Mode requested, command NOT yet sent — this ordering is the whole fix.
    expect(modes).toEqual([['real-gsd-1', 'default']]);
    expect(sent).toEqual([]);

    // The strip is already opted in, so it is visible during the interview rather than after it.
    expect(useSessionStore.getState().gsdEnabledSessions['real-gsd-1']).toBe(true);

    fireGsdKickoff('real-gsd-1', useSessionStore.getState);
    expect(sent).toEqual([['real-gsd-1', '/gsd-new-project']]);
  });

  it('sends the command only once, even if mode-confirmed arrives twice', () => {
    const localId = startGsdSession();
    adoptOptimisticSession(localId, realSession(), useSessionStore.setState, useSessionStore.getState);
    fireGsdKickoff('real-gsd-1', useSessionStore.getState);
    fireGsdKickoff('real-gsd-1', useSessionStore.getState);
    expect(sent).toEqual([['real-gsd-1', '/gsd-new-project']]);
  });

  it('sends immediately when the session is already in the target mode', () => {
    // Nothing will confirm a mode change that isn't needed, so waiting for one would hang forever.
    useSessionStore.setState({ remoteSessionModes: { 'real-gsd-1': 'default' } });
    const localId = startGsdSession();
    adoptOptimisticSession(localId, realSession(), useSessionStore.setState, useSessionStore.getState);
    expect(modes).toEqual([]);
    expect(sent).toEqual([['real-gsd-1', '/gsd-new-project']]);
  });

  it('falls back to sending after the timeout when no confirm ever arrives', async () => {
    vi.useFakeTimers();
    try {
      const localId = startGsdSession();
      adoptOptimisticSession(localId, realSession(), useSessionStore.setState, useSessionStore.getState);
      expect(sent).toEqual([]);
      // An older bridge, or a control request that failed, must not swallow the feature silently.
      vi.advanceTimersByTime(6_500);
      expect(sent).toEqual([['real-gsd-1', '/gsd-new-project']]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fire a kickoff armed for a session that was deleted', () => {
    const localId = startGsdSession();
    adoptOptimisticSession(localId, realSession(), useSessionStore.setState, useSessionStore.getState);
    useSessionStore.getState().deleteRemoteSession('real-gsd-1');
    fireGsdKickoff('real-gsd-1', useSessionStore.getState);
    expect(sent).toEqual([]);
  });

  it('leaves ordinary sessions completely alone', () => {
    useSessionStore.getState().startOptimisticRemoteSession(machine, { model: 'claude-opus-4-8' });
    const activeId = useSessionStore.getState().activeSessionId!;
    adoptOptimisticSession(activeId.slice('optimistic:'.length), realSession('plain-1'), useSessionStore.setState, useSessionStore.getState);
    expect(modes).toEqual([]);
    expect(sent).toEqual([]);
    expect(useSessionStore.getState().gsdEnabledSessions['plain-1']).toBeUndefined();
  });
});

describe('sanitizeProjectFolder', () => {
  it('turns a typed project name into a single safe folder segment', () => {
    expect(sanitizeProjectFolder('  My New App  ')).toBe('My-New-App');
    expect(sanitizeProjectFolder('a/b/c')).toBe('a-b-c');
  });

  it('refuses traversal and dotfiles rather than handing them to the bridge', () => {
    // The bridge confines cwd to the workspace root anyway, but a name that *looks* like an escape
    // should never leave the phone — it would silently fall back to the root and root the session
    // in the wrong place, which is the failure this whole feature exists to avoid.
    expect(sanitizeProjectFolder('../../etc')).toBe('etc');
    expect(sanitizeProjectFolder('.hidden')).toBe('hidden');
    expect(sanitizeProjectFolder('...')).toBe('');
    expect(sanitizeProjectFolder('   ')).toBe('');
  });

  it('drops characters a shell or path would treat specially', () => {
    expect(sanitizeProjectFolder('rm -rf $HOME; echo')).toBe('rm--rf-HOME-echo');
  });
});

/**
 * CD-059 — the Project folder picker used to be fed by the folder names of running sessions, which
 * on a workspace where every session starts at the root is one entry naming the root itself.
 */
describe('orderProjectFolders', () => {
  const workspace = ['atna', 'codedeck', 'nostr-relays/rocket-relay', 'yenn'];

  it('offers the whole workspace, not just folders that already have a session', () => {
    expect(orderProjectFolders(workspace, ['codedeck'])).toEqual([
      'codedeck', 'atna', 'nostr-relays/rocket-relay', 'yenn',
    ]);
  });

  it('floats folders with a running session to the top, order otherwise preserved', () => {
    expect(orderProjectFolders(workspace, ['yenn', 'atna'])).toEqual([
      'atna', 'yenn', 'codedeck', 'nostr-relays/rocket-relay',
    ]);
  });

  it('ignores active projects that are not workspace folders', () => {
    // e.g. a session rooted somewhere the scan no longer reports — it must not be offered twice.
    const out = orderProjectFolders(workspace, ['gone']);
    expect(out).toEqual(workspace);
  });

  it('falls back to the session-derived list when the bridge sent none (pre-v9)', () => {
    expect(orderProjectFolders([], ['codedeck', 'codedeck'])).toEqual(['codedeck']);
    expect(orderProjectFolders([], [])).toEqual([]);
  });
});

/**
 * CD-060 — the picker became a select, so what gets sent as `cwd` is no longer just the field's
 * text: it is the selection, except under "Other", where it is the text typed beneath it.
 */
describe('resolveProjectFolder', () => {
  it('sends the folder that was picked', () => {
    expect(resolveProjectFolder('yenn', '')).toBe('yenn');
  });

  it('keeps a nested folder intact', () => {
    // The bridge's own listing contains these and resolves them relative to the workspace root —
    // flattening the separator here would name a folder that doesn't exist and silently root the
    // session at the root instead.
    expect(resolveProjectFolder('nostr-relays/rocket-relay', '')).toBe('nostr-relays/rocket-relay');
  });

  it('treats the empty selection as the workspace root', () => {
    expect(resolveProjectFolder('', '')).toBe('');
  });

  it('sends the typed name under "Other" — this is how CD-058 starts a new project', () => {
    expect(resolveProjectFolder(PROJECT_FOLDER_CUSTOM, '  my-new-app ')).toBe('my-new-app');
  });

  it('falls back to the workspace root when "Other" is chosen but nothing is typed', () => {
    expect(resolveProjectFolder(PROJECT_FOLDER_CUSTOM, '   ')).toBe('');
  });

  it('ignores stale typed text once a real folder is picked', () => {
    // Switching from "Other" back to a listed folder must not send the abandoned draft name, which
    // would create a directory nobody asked for (the create checkbox is keyed off this value).
    expect(resolveProjectFolder('atna', 'half-typed-name')).toBe('atna');
  });
});

describe('sessionStore — workspace folders from the session list', () => {
  const machine: RemoteMachine = {
    npub: 'npub1folders', pubkeyHex: 'ff'.repeat(32), hostname: 'framework',
    relays: ['wss://relay.example'], connected: true,
  };

  beforeEach(() => {
    useSessionStore.setState({ machines: [machine], machineFolders: {}, machineProtocolVersion: {} });
  });

  it('removeMachine drops the machine-scoped folder list and protocol version', () => {
    // These describe a workspace and a bridge the phone is no longer paired to; left behind, an
    // unpaired machine's folders would show up in the next machine's picker.
    useSessionStore.setState({
      machineFolders: { [machine.pubkeyHex]: ['yenn'], other: ['elsewhere'] },
      machineProtocolVersion: { [machine.pubkeyHex]: 9, other: 8 },
    });
    useSessionStore.getState().removeMachine(machine.pubkeyHex);
    const state = useSessionStore.getState();
    expect(state.machineFolders[machine.pubkeyHex]).toBeUndefined();
    expect(state.machineProtocolVersion[machine.pubkeyHex]).toBeUndefined();
    expect(state.machineFolders.other).toEqual(['elsewhere']);
    expect(state.machineProtocolVersion.other).toBe(8);
  });
});

describe('sessionStore.updateTokenUsage', () => {
  beforeEach(() => {
    useSessionStore.setState({ tokenUsage: {} });
  });

  it('sets token usage for a session', () => {
    const store = useSessionStore.getState();
    store.updateTokenUsage('s1', {
      input_tokens: 1000,
      output_tokens: 500,
      total_cost_usd: 0.05,
    });

    const usage = useSessionStore.getState().tokenUsage['s1'];
    expect(usage.input_tokens).toBe(1000);
    expect(usage.output_tokens).toBe(500);
    expect(usage.total_cost_usd).toBe(0.05);
  });

  it('replaces previous usage for same session', () => {
    const store = useSessionStore.getState();
    store.updateTokenUsage('s1', { input_tokens: 100, output_tokens: 50, total_cost_usd: 0.01 });
    store.updateTokenUsage('s1', { input_tokens: 200, output_tokens: 100, total_cost_usd: 0.02 });

    const usage = useSessionStore.getState().tokenUsage['s1'];
    expect(usage.input_tokens).toBe(200);
  });
});

// QuestionGroupEntry advances to the next question optimistically by subscribing to
// `respondedCards.get(sessionId)` (a value), not the `isCardResponded` function. That only
// re-renders if markCardResponded swaps in NEW Map/Set references each answer. These tests
// lock in that reactive-identity contract so a future mutating refactor can't silently
// reintroduce the ~10s "tap → next question" lag.
describe('sessionStore.markCardResponded — reactive identity (drives optimistic question advance)', () => {
  const sessionId = 'grp-session';

  beforeEach(() => {
    useSessionStore.setState({ respondedCards: new Map() });
  });

  it('swaps in a fresh per-session Set reference on each answer', () => {
    const store = useSessionStore.getState();

    store.markCardResponded(sessionId, 'tool:q0');
    const setAfterQ0 = useSessionStore.getState().respondedCards.get(sessionId);
    expect(setAfterQ0?.has('tool:q0')).toBe(true);

    store.markCardResponded(sessionId, 'tool:q1');
    const setAfterQ1 = useSessionStore.getState().respondedCards.get(sessionId);

    // A value-selector on respondedCards.get(sessionId) only re-renders if the ref changes.
    expect(setAfterQ1).not.toBe(setAfterQ0);
    expect(setAfterQ1?.has('tool:q0')).toBe(true);
    expect(setAfterQ1?.has('tool:q1')).toBe(true);
  });

  it('keeps the same references when the card is already responded (no spurious re-render)', () => {
    const store = useSessionStore.getState();
    store.markCardResponded(sessionId, 'tool:q0');
    const mapBefore = useSessionStore.getState().respondedCards;
    const setBefore = mapBefore.get(sessionId);

    store.markCardResponded(sessionId, 'tool:q0'); // duplicate
    const mapAfter = useSessionStore.getState().respondedCards;

    expect(mapAfter).toBe(mapBefore);
    expect(mapAfter.get(sessionId)).toBe(setBefore);
  });

  it('isCardResponded reflects each answer (firstUnanswered derivation)', () => {
    const store = useSessionStore.getState();
    expect(store.isCardResponded(sessionId, 'tool:q0')).toBe(false);
    store.markCardResponded(sessionId, 'tool:q0');
    expect(useSessionStore.getState().isCardResponded(sessionId, 'tool:q0')).toBe(true);
    expect(useSessionStore.getState().isCardResponded(sessionId, 'tool:q1')).toBe(false);
  });
});

describe('sessionStore in-flight setting (mode/effort/model) pending + revert', () => {
  const sessionId = 'remote-sess-1';

  beforeEach(() => {
    useSessionStore.setState({
      remoteSessionModes: { [sessionId]: 'plan' },
      remoteSessionEffort: { [sessionId]: 'auto' },
      remoteSessionModel: { [sessionId]: 'claude-opus-4-8' },
      remoteSettingPending: {},
    });
  });

  it('clearSettingPending removes the in-flight marker', () => {
    useSessionStore.setState({
      remoteSettingPending: { [sessionId]: { kind: 'mode', prev: 'plan' } },
    });
    useSessionStore.getState().clearSettingPending(sessionId);
    expect(useSessionStore.getState().remoteSettingPending[sessionId]).toBeUndefined();
  });

  it('revertSetting restores the prior mode and clears pending', () => {
    // Simulate an optimistic switch plan -> acceptEdits that never got confirmed.
    useSessionStore.setState({
      remoteSessionModes: { [sessionId]: 'acceptEdits' },
      remoteSettingPending: { [sessionId]: { kind: 'mode', prev: 'plan' } },
    });
    useSessionStore.getState().revertSetting(sessionId);
    expect(useSessionStore.getState().remoteSessionModes[sessionId]).toBe('plan');
    expect(useSessionStore.getState().remoteSettingPending[sessionId]).toBeUndefined();
  });

  it('revertSetting restores the prior effort level', () => {
    useSessionStore.setState({
      remoteSessionEffort: { [sessionId]: 'max' },
      remoteSettingPending: { [sessionId]: { kind: 'effort', prev: 'high' } },
    });
    useSessionStore.getState().revertSetting(sessionId);
    expect(useSessionStore.getState().remoteSessionEffort[sessionId]).toBe('high');
    expect(useSessionStore.getState().remoteSettingPending[sessionId]).toBeUndefined();
  });

  it('revertSetting restores the prior model id', () => {
    useSessionStore.setState({
      remoteSessionModel: { [sessionId]: 'claude-haiku-4-5-20251001' },
      remoteSettingPending: { [sessionId]: { kind: 'model', prev: 'claude-opus-4-8' } },
    });
    useSessionStore.getState().revertSetting(sessionId);
    expect(useSessionStore.getState().remoteSessionModel[sessionId]).toBe('claude-opus-4-8');
    expect(useSessionStore.getState().remoteSettingPending[sessionId]).toBeUndefined();
  });

  it('revertSetting is a no-op when nothing is pending', () => {
    useSessionStore.setState({
      remoteSessionModes: { [sessionId]: 'acceptEdits' },
      remoteSettingPending: {},
    });
    useSessionStore.getState().revertSetting(sessionId);
    // Value untouched because there was no pending change to revert.
    expect(useSessionStore.getState().remoteSessionModes[sessionId]).toBe('acceptEdits');
  });
});
