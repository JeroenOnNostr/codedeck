import { describe, it, expect } from 'vitest';
import { OutputEntry } from '../types';
import { _buildDisplayEntries as buildDisplayEntries, findPendingPermission } from '../hooks/useDisplayEntries';

function makeEntry(overrides: Partial<OutputEntry> = {}): OutputEntry {
  return {
    entry_type: 'message',
    content: 'test',
    timestamp: new Date().toISOString(),
    metadata: { role: 'assistant' },
    ...overrides,
  };
}

function makeToolUse(name = 'Bash', content = 'Bash: ls'): OutputEntry {
  return makeEntry({
    entry_type: 'tool_use',
    content,
    metadata: { role: 'assistant', tool_name: name, tool_use_id: `tool_${Math.random()}` },
  });
}

function makeToolResult(content = 'result'): OutputEntry {
  return makeEntry({
    entry_type: 'tool_result',
    content,
    metadata: { tool_use_id: `tool_${Math.random()}` },
  });
}

function makeText(content: string, extra: Record<string, unknown> = {}): OutputEntry {
  return makeEntry({
    entry_type: 'message',
    content,
    metadata: { role: 'assistant', ...extra },
  });
}

function makePermission(id: string, extra: Record<string, unknown> = {}): OutputEntry {
  return makeEntry({
    entry_type: 'system',
    content: 'Permission needed: Bash',
    metadata: { special: 'permission_request', tool_name: 'Bash', tool_use_id: id, ...extra },
  });
}

function makeResultFor(id: string): OutputEntry {
  return makeEntry({ entry_type: 'tool_result', content: 'ok', metadata: { tool_use_id: id } });
}

describe('findPendingPermission', () => {
  it('returns the pending permission when unanswered', () => {
    const p = findPendingPermission([makeText('working'), makePermission('p1')], undefined);
    expect(p?.requestId).toBe('p1');
    expect(p?.toolName).toBe('Bash');
  });

  it('returns null once a tool_result answers it', () => {
    const outputs = [makePermission('p1'), makeResultFor('p1')];
    expect(findPendingPermission(outputs, undefined)).toBeNull();
  });

  it('returns null when answered optimistically via respondedCards', () => {
    expect(findPendingPermission([makePermission('p1')], new Set(['p1']))).toBeNull();
  });

  it('surfaces a permission buried before a long run of sub-agent tool entries', () => {
    const outputs: OutputEntry[] = [
      makeText('Now let me have a Plan agent design the implementation.'),
      makePermission('p1', { subagent: true, agent_label: 'Plan' }),
      ...Array.from({ length: 50 }, () => makeToolUse('Read', 'Read: file')),
    ];
    const p = findPendingPermission(outputs, undefined);
    expect(p?.requestId).toBe('p1');
    expect(p?.isSubAgent).toBe(true);
    expect(p?.agentLabel).toBe('Plan');
  });

  it('returns null for empty/undefined output', () => {
    expect(findPendingPermission(undefined, undefined)).toBeNull();
    expect(findPendingPermission([], undefined)).toBeNull();
  });
});

describe('buildDisplayEntries', () => {
  it('collapses text with display_hint collapse into tool group', () => {
    const outputs: OutputEntry[] = [
      makeText('Let me explore the codebase.', { display_hint: 'collapse' }),
      makeToolUse('Agent', 'Agent: Explore (Explore)'),
      makeToolResult('Found 5 files'),
    ];

    const display = buildDisplayEntries(outputs);
    expect(display).toHaveLength(1);
    expect(display[0].kind).toBe('tool_group');
    if (display[0].kind === 'tool_group') {
      expect(display[0].entries).toHaveLength(3);
    }
  });

  it('collapses subagent text with display_hint collapse into tool group', () => {
    const outputs: OutputEntry[] = [
      makeToolUse('Agent', 'Agent: Explore (Explore)'),
      makeText('Searching the codebase...', { subagent: true, display_hint: 'collapse' }),
      makeToolUse('Read', 'Read: /src/main.ts'),
      makeToolResult('file contents'),
      makeText('Here are my findings.', { subagent: true, display_hint: 'collapse' }),
      makeToolResult('Agent result'),
    ];

    const display = buildDisplayEntries(outputs);
    expect(display).toHaveLength(1);
    expect(display[0].kind).toBe('tool_group');
  });

  it('does NOT collapse plan text (special: plan)', () => {
    const outputs: OutputEntry[] = [
      makeEntry({
        entry_type: 'message',
        content: '## My Plan\n1. Fix bug\n2. Add tests',
        metadata: { role: 'assistant', special: 'plan', tool_use_id: 'plan_1' },
      }),
    ];

    const display = buildDisplayEntries(outputs);
    expect(display).toHaveLength(1);
    expect(display[0].kind).toBe('assistant_message');
  });

  it('shows text with display_hint show as individual message', () => {
    const outputs: OutputEntry[] = [
      makeToolUse('Bash', 'Bash: ls'),
      makeToolResult('file1.ts'),
      makeText('Based on my analysis, the issue is in file1.ts.', { display_hint: 'show' }),
    ];

    const display = buildDisplayEntries(outputs);
    expect(display).toHaveLength(2);
    expect(display[0].kind).toBe('tool_group');
    expect(display[1].kind).toBe('assistant_message');
  });

  it('defaults to show when no display_hint is set (old bridge compat)', () => {
    const outputs: OutputEntry[] = [
      makeText('Let me check that file.'),
      makeToolUse('Read', 'Read: /src/main.ts'),
      makeToolResult('file contents'),
      makeText('The file looks fine.'),
    ];

    const display = buildDisplayEntries(outputs);
    // Without display_hint, both texts default to 'show' (not collapsed)
    // text(show) + tool_use+tool_result(group) + text(show) = 3
    expect(display).toHaveLength(3);
    expect(display[0].kind).toBe('assistant_message');
    expect(display[1].kind).toBe('tool_group');
    expect(display[2].kind).toBe('assistant_message');
  });

  it('tool group summary counts only actual tool entries', () => {
    const outputs: OutputEntry[] = [
      makeText('Exploring...', { display_hint: 'collapse' }),
      makeToolUse('Agent', 'Agent: Explore (Explore)'),
      makeText('Sub-agent working...', { display_hint: 'collapse' }),
      makeToolUse('Read', 'Read: /src/main.ts'),
      makeToolResult('contents'),
    ];

    const display = buildDisplayEntries(outputs);
    expect(display).toHaveLength(1);
    if (display[0].kind === 'tool_group') {
      expect(display[0].summary).toMatch(/^3 action/);
    }
  });

  it('collapses display_hint collapse text even when no tool group is active yet', () => {
    const outputs: OutputEntry[] = [
      makeText('I will investigate the IPC issue by searching...', { display_hint: 'collapse' }),
      makeToolUse('Agent', 'Agent: Explore IPC (Explore)'),
    ];

    const display = buildDisplayEntries(outputs);
    expect(display).toHaveLength(1);
    expect(display[0].kind).toBe('tool_group');
  });

  it('does not collapse user messages', () => {
    const outputs: OutputEntry[] = [
      makeToolUse('Bash', 'Bash: ls'),
      makeEntry({
        entry_type: 'user_message',
        content: 'Stop',
        metadata: { role: 'user' },
      }),
    ];

    const display = buildDisplayEntries(outputs);
    expect(display).toHaveLength(2);
    expect(display[0].kind).toBe('tool_group');
    expect(display[1].kind).toBe('user_message');
  });

  it('never collapses plan text even with display_hint collapse', () => {
    const outputs: OutputEntry[] = [
      makeText('I will now propose a plan.', { display_hint: 'collapse' }),
      makeEntry({
        entry_type: 'message',
        content: '## Plan\n1. Step one\n2. Step two',
        metadata: { role: 'assistant', special: 'plan', tool_use_id: 'plan_1', display_hint: 'collapse' },
      }),
      makeEntry({
        entry_type: 'system',
        content: 'Plan approval needed',
        metadata: { special: 'plan_approval', tool_use_id: 'plan_1', has_plan: true },
      }),
    ];

    const display = buildDisplayEntries(outputs);
    // First text collapses into a tool group, plan shows individually, plan_approval shows individually
    expect(display.some(d => d.kind === 'assistant_message')).toBe(true);
    expect(display.some(d => d.kind === 'plan_approval')).toBe(true);
  });

  // Regression guard: multiSelect must reach the display so QuestionEntry can render the
  // toggle+Send UI. It was plumbed into the group but dropped on the single-question path,
  // which is exactly why multi-select questions looked broken on the phone.
  function makeQuestion(id: string, idx: number, count: number, multiSelect: boolean): OutputEntry {
    return makeEntry({
      entry_type: 'system',
      content: 'Pick options',
      metadata: {
        special: 'ask_question',
        tool_use_id: id,
        header: `Q${idx}`,
        options: [{ label: 'A' }, { label: 'B' }],
        multiSelect,
        question_index: idx,
        question_count: count,
      },
    });
  }

  it('carries multiSelect onto a SINGLE question display', () => {
    const display = buildDisplayEntries([makeQuestion('q_single', 0, 1, true)]);
    const q = display.find(d => d.kind === 'question');
    expect(q).toBeDefined();
    if (q && q.kind === 'question') expect(q.multiSelect).toBe(true);
  });

  it('carries per-question multiSelect onto a question GROUP', () => {
    const display = buildDisplayEntries([
      makeQuestion('q_grp', 0, 2, false),
      makeQuestion('q_grp', 1, 2, true),
    ]);
    const g = display.find(d => d.kind === 'question_group');
    expect(g).toBeDefined();
    if (g && g.kind === 'question_group') {
      expect(g.questions[0].multiSelect).toBe(false);
      expect(g.questions[1].multiSelect).toBe(true);
    }
  });
});
