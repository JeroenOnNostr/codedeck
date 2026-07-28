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

/**
 * The live line shown while a phase is executing, e.g.
 * `Phase 2 · plan 1/2 · task 2/3 · cover the build step`.
 *
 * This exists because the ordinary readout is *frozen* during an execute: with GSD's default
 * parallelization, per-plan state writes are skipped inside worktrees and batched after the wave
 * merges, so phase counts don't move for the entire run. Returns null when there's nothing real
 * to report — a strip that invents progress is worse than one that admits it doesn't know.
 */
export function executionLine(gsd: GsdState): string | null {
  const e = gsd.execution;
  if (!e) return null;

  const parts = [`Phase ${e.phase}`];
  if (e.plansTotal > 0) parts.push(`plan ${Math.min(e.plansDone + 1, e.plansTotal)}/${e.plansTotal}`);
  // Without a declared task count the numerator alone is still useful ("task 4"), just unbounded.
  if (e.tasksTotal) parts.push(`task ${e.tasksDone}/${e.tasksTotal}`);
  else if (e.tasksDone > 0) parts.push(`task ${e.tasksDone}`);
  if (e.lastTask) parts.push(e.lastTask);
  return parts.join(' · ');
}

export interface RecoveryChip { id: string; label: string; command: string }

/**
 * Recovery states are first-class in GSD and each has a way out, but they're invisible unless
 * surfaced: a paused thread or a failed verification otherwise just reads as a stale situation
 * word. A phone is exactly where you'd pick a paused thread back up.
 */
export function recoveryChips(gsd: GsdState): RecoveryChip[] {
  const chips: RecoveryChip[] = [];
  if (gsd.paused) chips.push({ id: 'resume', label: 'Resume', command: '/gsd-resume-work' });
  if (gsd.verifyFailed) chips.push({ id: 'reverify', label: 'Re-verify', command: '/gsd-verify-work' });
  if (gsd.blockers.length) {
    chips.push({
      id: 'debug',
      label: gsd.blockers.length > 1 ? `${gsd.blockers.length} blockers` : 'Blocked',
      command: '/gsd-debug',
    });
  }
  return chips;
}

/** Pre-flight cost for a phase, e.g. `2 plans · 1 needs you`. Null when GSD wasn't asked. */
export function preflightLabel(phase: GsdPhase): string | null {
  if (phase.planCount === null) return null;
  const plans = `${phase.planCount} plan${phase.planCount === 1 ? '' : 's'}`;
  // Only worth saying when it's non-zero — "0 needs you" is noise on a phone-width row.
  return phase.needsYou ? `${plans} · ${phase.needsYou} needs you` : plans;
}
