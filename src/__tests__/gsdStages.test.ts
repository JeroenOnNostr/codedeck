import { describe, it, expect } from 'vitest';
import { phaseStages, situationLabel, stripSummary, recommendedAction } from '../utils/gsdStages';
import type { GsdPhase, GsdState } from '../types';

function phase(overrides: Partial<GsdPhase> = {}): GsdPhase {
  return {
    number: '1',
    name: 'Setup',
    diskStatus: 'empty',
    plans: 0,
    summaries: 0,
    recentlyTouched: false,
    action: null,
    command: null,
    ...overrides,
  };
}

function state(overrides: Partial<GsdState> = {}): GsdState {
  return {
    available: true,
    situation: 'executing',
    summary: '',
    milestone: null,
    currentPhase: null,
    totalPhases: null,
    percent: 0,
    phases: [],
    actions: [],
    recommended: null,
    ...overrides,
  };
}

describe('phaseStages', () => {
  it('maps GSD disk statuses onto the Discuss/Plan/Execute triple', () => {
    expect(phaseStages(phase({ diskStatus: 'complete' })).marks).toEqual(['✓', '✓', '✓']);
    expect(phaseStages(phase({ diskStatus: 'planned' })).marks).toEqual(['✓', '✓', '○']);
    expect(phaseStages(phase({ diskStatus: 'discussed' })).marks).toEqual(['✓', '○', '·']);
    expect(phaseStages(phase({ diskStatus: 'empty' })).marks).toEqual(['·', '·', '·']);
  });

  it('distinguishes executed (needs verification) from complete', () => {
    // Both have all plans summarized; only one has passed verification. Collapsing them would
    // hide the single most actionable state in the whole workflow.
    expect(phaseStages(phase({ diskStatus: 'executed' })).label).toBe('Verification required');
    expect(phaseStages(phase({ diskStatus: 'complete' })).label).toBe('Complete');
  });

  it('falls back safely for an unrecognised status', () => {
    const s = phaseStages(phase({ diskStatus: 'some_future_status' }));
    expect(s.marks).toEqual(['·', '·', '·']);
    expect(s.label).toBe('Up next');
  });

  it('uses the phase action when the status is unknown but GSD suggests a step', () => {
    const s = phaseStages(phase({ diskStatus: 'no_directory', action: 'discuss' }));
    expect(s.label).toBe('Ready to discuss');
  });
});

describe('situationLabel', () => {
  it('humanizes known situations', () => {
    expect(situationLabel('executing')).toBe('Executing');
    expect(situationLabel('verify-pending')).toBe('Verify');
    expect(situationLabel('needs-first-phase')).toBe('Plan first phase');
  });

  it('degrades to a neutral label for an unknown situation', () => {
    expect(situationLabel('something-new')).toBe('GSD');
  });
});

describe('stripSummary', () => {
  it('renders the full one-liner when GSD knows everything', () => {
    const s = stripSummary(state({
      milestone: 'v1.0 — MVP',
      currentPhase: '2',
      totalPhases: 3,
      situation: 'executing',
      percent: 50,
    }));
    expect(s).toBe('v1.0 — MVP · Phase 2/3 · Executing · 50%');
  });

  it('omits parts GSD has not resolved rather than printing null or 0', () => {
    const s = stripSummary(state({ situation: 'planning', percent: 0 }));
    expect(s).toBe('Planning · 0%');
    expect(s).not.toContain('null');
    expect(s).not.toContain('undefined');
  });

  it('falls back to the phase count when totalPhases is missing', () => {
    const s = stripSummary(state({
      currentPhase: '1',
      phases: [phase({ number: '1' }), phase({ number: '2' })],
      percent: 10,
    }));
    expect(s).toContain('Phase 1/2');
  });
});

describe('recommendedAction', () => {
  const a = { id: 'plan-phase', label: 'Plan phase 1', command: '/gsd-plan-phase', recommended: false };
  const b = { id: 'execute-phase', label: 'Execute', command: '/gsd-execute-phase', recommended: true };

  it('prefers the action matching the recommended id', () => {
    expect(recommendedAction(state({ actions: [a, b], recommended: 'plan-phase' }))?.id).toBe('plan-phase');
  });

  it('falls back to the flagged action, then to the first', () => {
    expect(recommendedAction(state({ actions: [a, b], recommended: 'gone' }))?.id).toBe('execute-phase');
    expect(recommendedAction(state({ actions: [a], recommended: null }))?.id).toBe('plan-phase');
  });

  it('returns null when GSD suggests nothing', () => {
    expect(recommendedAction(state({ actions: [] }))).toBeNull();
  });
});
