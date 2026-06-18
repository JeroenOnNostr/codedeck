import { describe, it, expect, beforeEach } from 'vitest';
import { useSessionStore } from '../stores/sessionStore';
import { OutputEntry } from '../types';

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
