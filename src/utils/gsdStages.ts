/**
 * GSD phase status → the Discuss / Plan / Execute stage triple.
 *
 * This vocabulary is GSD's own — it comes from `gsd-core/workflows/manager.md`, where /gsd-manager
 * renders the same three columns in the terminal. Mirroring it exactly means the phone and the
 * desktop dashboard describe a phase identically, which matters when you're driving one workflow
 * from both.
 *
 * The three marks read left→right as Discuss, Plan, Execute:
 *   ✓ done · ◆ in flight / needs you · ○ ready to start · · not reached yet
 */

import type { GsdPhase, GsdState } from '../types';

export type StageMark = '✓' | '◆' | '○' | '·';

export interface PhaseStages {
  /** [Discuss, Plan, Execute] */
  marks: [StageMark, StageMark, StageMark];
  label: string;
}

const STAGES: Record<string, PhaseStages> = {
  complete:   { marks: ['✓', '✓', '✓'], label: 'Complete' },
  executed:   { marks: ['✓', '✓', '◆'], label: 'Verification required' },
  partial:    { marks: ['✓', '✓', '◆'], label: 'Executing…' },
  planned:    { marks: ['✓', '✓', '○'], label: 'Ready to execute' },
  discussed:  { marks: ['✓', '○', '·'], label: 'Ready to plan' },
  researched: { marks: ['✓', '○', '·'], label: 'Ready to plan' },
  empty:      { marks: ['·', '·', '·'], label: 'Up next' },
};

const UNKNOWN: PhaseStages = { marks: ['·', '·', '·'], label: 'Up next' };

export function phaseStages(phase: GsdPhase): PhaseStages {
  const base = STAGES[phase.diskStatus] ?? UNKNOWN;
  // A phase GSD has an action for is reachable now — say so instead of the passive "Up next".
  if (base === UNKNOWN && phase.action) {
    return { marks: ['·', '·', '·'], label: `Ready to ${phase.action}` };
  }
  return base;
}

/** Human label for `GsdState.situation`, for the collapsed one-liner. */
const SITUATIONS: Record<string, string> = {
  'no-project': 'No project',
  'needs-first-phase': 'Plan first phase',
  'planning': 'Planning',
  'executing': 'Executing',
  'verify-pending': 'Verify',
  'verify-failed': 'Verify failed',
  'paused': 'Paused',
  'blocked': 'Blocked',
  'idle-stranded': 'Idle',
  'complete': 'Complete',
  'unknown': 'GSD',
};

export function situationLabel(situation: string): string {
  return SITUATIONS[situation] ?? 'GSD';
}

/**
 * The one-line summary shown in the collapsed strip, e.g.
 * `v1.0 — MVP · Phase 2/3 · Executing · 50%`. Parts that GSD hasn't resolved are dropped
 * rather than rendered as "null" or "0".
 */
export function stripSummary(gsd: GsdState): string {
  const parts: string[] = [];
  if (gsd.milestone) parts.push(gsd.milestone);

  const total = gsd.totalPhases ?? (gsd.phases.length || null);
  if (gsd.currentPhase && total) parts.push(`Phase ${gsd.currentPhase}/${total}`);
  else if (gsd.currentPhase) parts.push(`Phase ${gsd.currentPhase}`);
  else if (total) parts.push(`${total} phases`);

  parts.push(situationLabel(gsd.situation));
  parts.push(`${gsd.percent}%`);
  return parts.join(' · ');
}

/** The action the collapsed strip offers as a tappable chip, or null if GSD suggests nothing. */
export function recommendedAction(gsd: GsdState) {
  if (!gsd.actions.length) return null;
  return gsd.actions.find(a => a.id === gsd.recommended)
    ?? gsd.actions.find(a => a.recommended)
    ?? gsd.actions[0];
}
