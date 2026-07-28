import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useSessionStore } from '../stores/sessionStore';
import { useUIStore } from '../stores/uiStore';
import GsdStageBar from '../components/GsdStageBar';
import type { GsdPhase, GsdState } from '../types';

/**
 * Rendered through the real client path (createRoot in jsdom), NOT renderToStaticMarkup:
 * zustand v5 hands `getInitialState` to useSyncExternalStore as the server snapshot, so an
 * SSR render always sees the store's *initial* state and every selector comes back empty.
 */

vi.mock('../styles/gsd.css', () => ({}));
vi.mock('../styles/modal.css', () => ({}));

// Tells React these renders are inside act(), so it batches effects instead of warning.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function phase(o: Partial<GsdPhase> = {}): GsdPhase {
  return { number: '1', name: 'Setup', diskStatus: 'complete', plans: 1, summaries: 1, recentlyTouched: false, action: null, command: null, planCount: null, needsYou: null, ...o };
}

function gsd(o: Partial<GsdState> = {}): GsdState {
  return {
    installed: true,
    available: true,
    situation: 'executing',
    summary: 'Executing phase 2',
    milestone: 'v1.0 — MVP',
    currentPhase: '2',
    totalPhases: 3,
    percent: 50,
    phases: [
      phase(),
      phase({ number: '2', name: 'Build', diskStatus: 'planned', summaries: 0, action: 'execute', command: '/gsd-execute-phase 2' }),
    ],
    actions: [{ id: 'execute-phase', label: 'Execute phase 2', command: '/gsd-execute-phase 2', recommended: true }],
    recommended: 'execute-phase',
    paused: false,
    blockers: [],
    verifyFailed: false,
    execution: null,
    ...o,
  };
}

let container: HTMLDivElement;
let root: Root;

function render(sessionId = 's1'): string {
  act(() => { root.render(<GsdStageBar sessionId={sessionId} />); });
  return container.innerHTML;
}

beforeEach(() => {
  // Reset every per-session GSD map, not just the snapshot: `gsdStartedSessions` persists across
  // tests otherwise and silently changes what setup mode renders.
  useSessionStore.setState({ remoteSessionGsd: {}, gsdEnabledSessions: {}, gsdStartedSessions: {} });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
});

describe('GsdStageBar', () => {
  it('renders nothing when the bridge reported no GSD snapshot', () => {
    expect(render()).toBe('');
  });

  it('renders nothing for a non-GSD project', () => {
    // The common case — most sessions aren't GSD projects and must be visually untouched.
    useSessionStore.setState({ remoteSessionGsd: { s1: gsd({ available: false }) } });
    expect(render()).toBe('');
  });

  it('renders the summary line for a GSD session', () => {
    useSessionStore.setState({ remoteSessionGsd: { s1: gsd() } });
    const html = render();
    expect(html).toContain('gsd-bar');
    expect(html).toContain('Phase 2/3');
    expect(html).toContain('Executing');
    expect(html).toContain('50%');
  });

  it('offers the recommended action as a tappable chip carrying the real command', () => {
    useSessionStore.setState({ remoteSessionGsd: { s1: gsd() } });
    const html = render();
    expect(html).toContain('Execute phase 2');
    // The command must reach the button in the flat form the local install understands.
    expect(html).toContain('/gsd-execute-phase 2');
    expect(html).not.toContain('/gsd:');
  });

  it('renders without an action chip when GSD suggests nothing', () => {
    useSessionStore.setState({ remoteSessionGsd: { s1: gsd({ actions: [], recommended: null }) } });
    const html = render();
    expect(html).toContain('gsd-bar');
    expect(html).not.toContain('gsd-bar-action');
  });

  it('sizes the meter to the reported percentage', () => {
    useSessionStore.setState({ remoteSessionGsd: { s1: gsd({ percent: 75 }) } });
    expect(render()).toContain('width: 75%');
  });

  it('clamps an out-of-range percentage instead of overflowing the meter', () => {
    useSessionStore.setState({ remoteSessionGsd: { s1: gsd({ percent: 140 }) } });
    expect(render()).toContain('width: 100%');
  });

  it('sends the command as ordinary session input when the chip is tapped', () => {
    const sent: Array<[string, string]> = [];
    useSessionStore.setState({
      remoteSessionGsd: { s1: gsd() },
      sendMessage: (async (id: string, text: string) => { sent.push([id, text]); }) as never,
    });
    render();
    const chip = container.querySelector('.gsd-bar-action') as HTMLButtonElement;
    expect(chip).toBeTruthy();
    act(() => { chip.click(); });
    expect(sent).toEqual([['s1', '/gsd-execute-phase 2']]);
  });

  it('opens the phase sheet when the summary is tapped', () => {
    useSessionStore.setState({
      remoteSessionGsd: { s1: gsd() },
      refreshGsd: (async () => {}) as never,
    });
    render();
    expect(document.querySelector('.gsd-phase-row')).toBeNull();
    act(() => { (container.querySelector('.gsd-bar-main') as HTMLButtonElement).click(); });
    const rows = document.querySelectorAll('.gsd-phase-row');
    expect(rows).toHaveLength(2);
    // Phase 1 is complete → nothing to run; phase 2 is planned → tappable.
    expect((rows[0] as HTMLButtonElement).disabled).toBe(true);
    expect((rows[1] as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('GsdStageBar — setup mode (per-session opt-in)', () => {
  const notAProject = () => gsd({
    installed: true,
    available: false,
    situation: 'no-project',
    phases: [],
    actions: [
      { id: 'new-project', label: 'Start a new project', command: '/gsd-new-project', recommended: true },
      { id: 'map-codebase', label: 'Map an existing codebase', command: '/gsd-map-codebase', recommended: false },
    ],
    recommended: 'new-project',
  });

  it('stays hidden on a non-GSD session that was never opted in', () => {
    // The whole point of opt-in: the repos that will never use GSD look untouched.
    useSessionStore.setState({ remoteSessionGsd: { s1: notAProject() }, gsdEnabledSessions: {} });
    expect(render()).toBe('');
  });

  it('shows Start once the session is opted in', () => {
    useSessionStore.setState({ remoteSessionGsd: { s1: notAProject() }, gsdEnabledSessions: { s1: true } });
    const html = render();
    expect(html).toContain('Start GSD here');
    expect(html).toContain('Map existing code');
    expect(html).toContain('GSD not set up in this project');
  });

  it('says what each setup button will actually do', () => {
    // "Map codebase" read as a mystery button in use — the tooltip has to name the outcome, not
    // just echo the command.
    useSessionStore.setState({ remoteSessionGsd: { s1: notAProject() }, gsdEnabledSessions: { s1: true } });
    const html = render();
    expect(html).toContain('.planning/codebase/');
    expect(html).toContain('Interview → requirements → roadmap');
  });

  it('stays hidden when opted in but GSD is not installed on the laptop', () => {
    // Offering a Start button with nothing behind it is worse than offering nothing.
    useSessionStore.setState({
      remoteSessionGsd: { s1: notAProject() },
      gsdEnabledSessions: { s1: true },
    });
    useSessionStore.setState({
      remoteSessionGsd: { s1: { ...notAProject(), installed: false, actions: [] } },
    });
    expect(render()).toBe('');
  });

  it('sends /gsd-new-project when Start is tapped', () => {
    const sent: string[] = [];
    useSessionStore.setState({
      remoteSessionGsd: { s1: notAProject() },
      gsdEnabledSessions: { s1: true },
      sendMessage: (async (_id: string, text: string) => { sent.push(text); }) as never,
    });
    render();
    const btns = Array.from(container.querySelectorAll('.gsd-bar-action')) as HTMLButtonElement[];
    act(() => { btns.find(b => b.textContent === 'Start GSD here')!.click(); });
    expect(sent).toEqual(['/gsd-new-project']);
  });
});

describe('GsdStageBar — live states', () => {
  it('says "Waiting on you" instead of a stale phase readout', () => {
    useSessionStore.setState({ remoteSessionGsd: { s1: gsd() } });
    act(() => { root.render(<GsdStageBar sessionId="s1" sessionState="waiting_question" />); });
    const html = container.innerHTML;
    expect(html).toContain('Waiting on you');
    expect(html).not.toContain('Phase 2/3');
    // Firing the recommended command while blocked would answer the wrong prompt.
    expect(html).not.toContain('gsd-bar-action');
  });

  it('shows live task progress while executing, not the frozen phase status', () => {
    useSessionStore.setState({ remoteSessionGsd: { s1: gsd({
      execution: { phase: '2', plansTotal: 2, plansDone: 0, currentPlan: '02-01', tasksDone: 2, tasksTotal: 3, lastTask: 'cover the build step' },
    }) } });
    const html = render();
    expect(html).toContain('task 2/3');
    expect(html).toContain('cover the build step');
    // No action chip mid-run: tapping "Execute phase 2" during phase 2 double-runs it.
    expect(html).not.toContain('gsd-bar-action');
  });

  it('surfaces recovery chips wired to their escape command', () => {
    useSessionStore.setState({ remoteSessionGsd: { s1: gsd({ paused: true }) } });
    const html = render();
    expect(html).toContain('Resume');
    expect(html).toContain('/gsd-resume-work');
  });

  it('sends the recovery command when its chip is tapped', () => {
    const sent: string[] = [];
    useSessionStore.setState({
      remoteSessionGsd: { s1: gsd({ blockers: ['db down'] }) },
      sendMessage: (async (_id: string, text: string) => { sent.push(text); }) as never,
    });
    render();
    act(() => { (container.querySelector('.gsd-bar-action--recovery') as HTMLButtonElement).click(); });
    expect(sent).toEqual(['/gsd-debug']);
  });
});

/**
 * CD-055 / CD-056 — the two ways a tap could do the wrong thing.
 *
 * CD-055: `run()` was fire-and-forget. Tapping while a turn was in flight posted the command into
 * the stream, so it looked sent, but the agent never acted on it. Losing a tap silently is worse
 * than refusing it.
 *
 * CD-056: `Start GSD` was offered with no `has_git` check. GSD's new-project runs `git init` when
 * the directory isn't a repo, so tapping it at a multi-project root would create a repo on top of
 * every project inside it.
 */
describe('GsdStageBar — tap guards', () => {
  const notAProject = (o: Partial<GsdState> = {}) => gsd({
    installed: true,
    available: false,
    situation: 'no-project',
    phases: [],
    actions: [
      { id: 'new-project', label: 'Start a new project', command: '/gsd-new-project', recommended: true },
      { id: 'map-codebase', label: 'Map an existing codebase', command: '/gsd-map-codebase', recommended: false },
    ],
    recommended: 'new-project',
    ...o,
  });

  function renderWith(state: string | undefined, sessionId = 's1') {
    act(() => { root.render(<GsdStageBar sessionId={sessionId} sessionState={state} />); });
    return container.innerHTML;
  }

  it('swallows a tap while a turn is running instead of posting a command that never runs', () => {
    const sent: string[] = [];
    useSessionStore.setState({
      remoteSessionGsd: { s1: gsd() },
      sendMessage: (async (_id: string, text: string) => { sent.push(text); }) as never,
    });
    renderWith('running');
    // The chip is suppressed entirely while busy, so there is nothing to tap...
    const chip = container.querySelector('.gsd-bar-action:not(.gsd-bar-action--recovery)');
    expect(chip).toBeNull();
    // ...and even a recovery chip that IS rendered refuses to fire.
    expect(sent).toEqual([]);
  });

  it('disables the recovery chips while a turn is running', () => {
    const sent: string[] = [];
    useSessionStore.setState({
      remoteSessionGsd: { s1: gsd({ paused: true }) },
      sendMessage: (async (_id: string, text: string) => { sent.push(text); }) as never,
    });
    renderWith('running');
    const chip = container.querySelector('.gsd-bar-action--recovery') as HTMLButtonElement | null;
    if (chip) {
      expect(chip.disabled).toBe(true);
      act(() => { chip.click(); });
    }
    expect(sent).toEqual([]);
  });

  it('still sends normally when the session is idle', () => {
    // The guard must not break the ordinary path — this is the behaviour CD-053 shipped for.
    const sent: string[] = [];
    useSessionStore.setState({
      remoteSessionGsd: { s1: gsd() },
      sendMessage: (async (_id: string, text: string) => { sent.push(text); }) as never,
    });
    renderWith('idle');
    const chip = container.querySelector('.gsd-bar-action') as HTMLButtonElement;
    expect(chip.disabled).toBe(false);
    act(() => { chip.click(); });
    expect(sent).toEqual(['/gsd-execute-phase 2']);
  });

  /**
   * CD-058. The original CD-056 fix rendered `Start GSD` *disabled* here — and `.gsd-bar-action`
   * had no `:disabled` rule, so at the workspace root (not a repo) it looked live and ate every
   * tap in silence. That is the literal "Start GSD does nothing" report. The dead end is now the
   * route to a directory GSD *can* have.
   */
  it('offers a way out instead of a dead button when the directory is not a git repo', () => {
    const sent: string[] = [];
    useSessionStore.setState({
      remoteSessionGsd: { s1: notAProject({ hasGit: false }) },
      gsdEnabledSessions: { s1: true },
      sendMessage: (async (_id: string, text: string) => { sent.push(text); }) as never,
    });
    const html = renderWith('idle');
    expect(html).toContain("GSD needs its own folder");
    // No `git init` command may be offered here — that was the CD-056 hazard.
    expect(sent).toEqual([]);
    expect(html).not.toContain('/gsd-new-project');

    const out = container.querySelector('.gsd-bar-action--primary') as HTMLButtonElement;
    expect(out.disabled).toBe(false);
    expect(out.textContent).toBe('New GSD project');
    act(() => { out.click(); });
    // It opens New Session already switched to the GSD flow, and still sends nothing.
    expect(useUIStore.getState().newSessionOpen).toBe(true);
    expect(useUIStore.getState().newSessionGsd).toBe(true);
    expect(sent).toEqual([]);
  });

  it('allows Start GSD in a real git repo', () => {
    const sent: string[] = [];
    useSessionStore.setState({
      remoteSessionGsd: { s1: notAProject({ hasGit: true }) },
      gsdEnabledSessions: { s1: true },
      sendMessage: (async (_id: string, text: string) => { sent.push(text); }) as never,
    });
    const html = renderWith('idle');
    expect(html).toContain('GSD not set up in this project');
    const start = container.querySelector('.gsd-bar-action--primary') as HTMLButtonElement;
    expect(start.disabled).toBe(false);
    act(() => { start.click(); });
    expect(sent).toEqual(['/gsd-new-project']);
  });

  it('does not disable Start GSD when an older bridge omits hasGit', () => {
    // Protocol < v8 never sends the field. `undefined` must not be read as "no repo", or the
    // button would go permanently dead against an un-upgraded laptop.
    const sent: string[] = [];
    useSessionStore.setState({
      remoteSessionGsd: { s1: notAProject() },
      gsdEnabledSessions: { s1: true },
      sendMessage: (async (_id: string, text: string) => { sent.push(text); }) as never,
    });
    renderWith('idle');
    const start = container.querySelector('.gsd-bar-action--primary') as HTMLButtonElement;
    expect(start.disabled).toBe(false);
    act(() => { start.click(); });
    expect(sent).toEqual(['/gsd-new-project']);
  });

  /**
   * CD-058. GSD writes nothing under `.planning/` until its interview is well under way, so for the
   * whole questioning stage the project still reports "not a GSD project". Offering `Start GSD here`
   * there is offering to throw the half-finished interview away — and it reads as "continue".
   */
  it('does not offer a plain Start once GSD setup has already been sent here', () => {
    useSessionStore.setState({
      remoteSessionGsd: { s1: notAProject({ hasGit: true }) },
      gsdEnabledSessions: { s1: true },
      gsdStartedSessions: { s1: true },
    });
    const html = renderWith('idle');
    expect(html).toContain('GSD setup in progress');
    expect(html).not.toContain('Start GSD here');
    // Restarting stays possible, but only under a word that cannot be read as "continue".
    expect(html).toContain('Restart GSD setup');
    // Mapping an existing codebase mid-interview would fight the interview — drop it.
    expect(html).not.toContain('Map existing code');
  });

  it('records that setup was started when the Start button is tapped', () => {
    useSessionStore.setState({
      remoteSessionGsd: { s1: notAProject({ hasGit: true }) },
      gsdEnabledSessions: { s1: true },
      gsdStartedSessions: {},
      sendMessage: (async () => {}) as never,
    });
    renderWith('idle');
    act(() => { (container.querySelector('.gsd-bar-action--primary') as HTMLButtonElement).click(); });
    expect(useSessionStore.getState().gsdStartedSessions['s1']).toBe(true);
  });

  it('reports progress instead of dead buttons while GSD is setting itself up', () => {
    // Every action here is a no-op mid-turn, and the usual reason the turn is running is the
    // interview this strip just started. Three unresponsive buttons is the bug; a status line
    // is the answer.
    useSessionStore.setState({
      remoteSessionGsd: { s1: notAProject({ hasGit: true }) },
      gsdEnabledSessions: { s1: true },
    });
    const html = renderWith('running');
    expect(html).toContain('Setting GSD up…');
    expect(container.querySelector('.gsd-bar-action')).toBeNull();
  });

  it('says GSD is waiting on you when the setup turn blocks on a question', () => {
    useSessionStore.setState({
      remoteSessionGsd: { s1: notAProject({ hasGit: true }) },
      gsdEnabledSessions: { s1: true },
    });
    const html = renderWith('waiting_question');
    expect(html).toContain('GSD is waiting on you');
    expect(container.querySelector('.gsd-bar-action')).toBeNull();
  });
});
