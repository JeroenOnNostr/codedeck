import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useSessionStore } from '../stores/sessionStore';
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
  return { number: '1', name: 'Setup', diskStatus: 'complete', plans: 1, summaries: 1, recentlyTouched: false, action: null, command: null, ...o };
}

function gsd(o: Partial<GsdState> = {}): GsdState {
  return {
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
  useSessionStore.setState({ remoteSessionGsd: {} });
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
