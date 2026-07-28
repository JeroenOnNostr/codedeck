import { useState } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { useUIStore } from '../stores/uiStore';
import { stripSummary, recommendedAction, executionLine, recoveryChips } from '../utils/gsdStages';
import GsdStagePanel from './GsdStagePanel';
import '../styles/gsd.css';

/**
 * Collapsed GSD stage strip, pinned under the SessionHeader for remote sessions.
 *
 * GSD is command-driven — no hooks, no ambient UI — so driving a workflow from a phone otherwise
 * means remembering which phase you're on and typing `/gsd-execute-phase 2` on a touch keyboard.
 * This answers "where am I" in one line and turns the next step into one tap.
 *
 * Four states, in priority order, because they answer different questions:
 *   1. waiting on you  — the session is blocked. Nothing else matters until you answer.
 *   2. executing       — a phase is running. Show live task progress, NOT the frozen phase status:
 *                        during a parallel wave the phase counts don't move at all.
 *   3. recovery        — paused / blocked / verification failed, each with a way out.
 *   4. idle            — the ordinary "milestone · phase N/M · situation · %" readout.
 *
 * Visibility: a real GSD project always shows. A project without `.planning/` shows ONLY if the
 * user opted this session in — otherwise the ~25 repos that will never use GSD stay untouched.
 */
export default function GsdStageBar({ sessionId, sessionState }: { sessionId: string; sessionState?: string }) {
  const gsd = useSessionStore((s) => s.remoteSessionGsd[sessionId]);
  const enabled = useSessionStore((s) => s.gsdEnabledSessions[sessionId]);
  const sendMessage = useSessionStore((s) => s.sendMessage);
  const refreshGsd = useSessionStore((s) => s.refreshGsd);
  const machine = useSessionStore((s) => s.getMachineForSession(sessionId));
  const started = useSessionStore((s) => s.gsdStartedSessions[sessionId] === true);
  const markGsdStarted = useSessionStore((s) => s.markGsdStarted);
  const setNewSessionOpen = useUIStore((s) => s.setNewSessionOpen);
  const [open, setOpen] = useState(false);

  if (!gsd) return null;
  // Not a GSD project: only visible once opted in, and only when GSD could actually do something.
  const setupMode = !gsd.available;
  if (setupMode && !(enabled && gsd.installed)) return null;

  // CD-055. A turn is already running, so the agent will not act on a new command — the bridge
  // folds it into the running turn and it is lost. It still renders in the stream, which is worse
  // than refusing it: the tap looks like it worked. Block at the source instead.
  const busy = sessionState === 'running'
    || sessionState === 'waiting_question'
    || sessionState === 'waiting_permission';

  const run = (command: string) => {
    if (busy) return;
    // Same path as typing it — the command shows up in the stream, so a tap is never invisible.
    // No refresh here: GSD state only moves once the command finishes, and MainPanel re-polls
    // on turn end.
    void sendMessage(sessionId, command);
    setOpen(false);
  };

  /** Setup commands additionally record that GSD has been started here — see the strip below. */
  const runSetup = (command: string) => {
    if (busy) return;
    markGsdStarted(sessionId);
    run(command);
  };

  // --- Setup mode: this project isn't a GSD project yet ---
  if (setupMode) {
    const start = gsd.actions.find(a => a.id === 'new-project');
    const map = gsd.actions.find(a => a.id === 'map-codebase');
    // CD-056. `new-project` runs `git init` when the directory isn't a repo, so starting GSD
    // somewhere like a multi-project workspace root would create a repo on top of every project
    // inside it. `hasGit === false` is an explicit "no" from the bridge; `undefined` means an older
    // bridge that doesn't send the field, and must not disable the button.
    const noRepo = gsd.hasGit === false;

    // CD-058. While a turn is in flight every action here is a no-op (see `busy` above), and the
    // overwhelmingly common reason for that is the GSD interview this strip just started. Say so
    // instead of rendering three buttons that ignore taps.
    if (busy) {
      return (
        <div className="gsd-bar gsd-bar--setup">
          <span className="gsd-bar-summary gsd-bar-summary--muted">
            {sessionState === 'waiting_question' || sessionState === 'waiting_permission'
              ? 'GSD is waiting on you'
              : 'Setting GSD up…'}
          </span>
        </div>
      );
    }

    // CD-058. `Start GSD` used to render here disabled, and `.gsd-bar-action` had no `:disabled`
    // rule — so at the workspace root (not a repo) it looked exactly like a live button and ate
    // every tap in silence. That was the whole "Start GSD does nothing" report. A directory GSD
    // must not `git init` is not a disabled button, it is the wrong directory: send the user to
    // the flow that makes a right one.
    if (noRepo) {
      return (
        <div className="gsd-bar gsd-bar--setup">
          <span className="gsd-bar-summary gsd-bar-summary--muted">
            GSD needs its own folder — this one isn't a git repo
          </span>
          <button
            className="gsd-bar-action gsd-bar-action--primary"
            onClick={() => setNewSessionOpen(true, machine ?? null, true)}
            title="Create a project folder and start GSD there"
          >
            New GSD project
          </button>
        </div>
      );
    }

    // CD-058. GSD writes nothing to `.planning/` until its interview is well under way, so between
    // "started" and "set up" the project still looks untouched. Left alone the strip keeps offering
    // to start it, and tapping that throws the half-finished interview away and begins a new one.
    // Say where we are, and make the restart say `Restart` so it can't be mistaken for `continue`.
    return (
      <div className="gsd-bar gsd-bar--setup">
        <span className="gsd-bar-summary gsd-bar-summary--muted">
          {started ? 'GSD setup in progress — answer it below' : 'GSD not set up in this project'}
        </span>
        {map && !started && (
          <button
            className="gsd-bar-action"
            onClick={() => runSetup(map.command)}
            title={`Analyse the existing code into .planning/codebase/ (${map.command})`}
          >
            Map existing code
          </button>
        )}
        {start && (
          <button
            className="gsd-bar-action gsd-bar-action--primary"
            onClick={() => runSetup(start.command)}
            title={started
              ? `Start the interview over from scratch (${start.command})`
              : `Interview → requirements → roadmap (${start.command})`}
          >
            {started ? 'Restart GSD setup' : 'Start GSD here'}
          </button>
        )}
      </div>
    );
  }

  const waiting = sessionState === 'waiting_question' || sessionState === 'waiting_permission';
  const exec = executionLine(gsd);
  const chips = recoveryChips(gsd);
  const action = recommendedAction(gsd);
  const pct = Math.max(0, Math.min(100, gsd.percent));

  // While blocked or mid-execute the recommended action is stale or destructive to fire, so the
  // chip is suppressed. Offering "Execute phase 2" during phase 2 is how you get a double run.
  // `busy` rather than `waiting` so it also covers a plain running turn (CD-055) — a command sent
  // then is swallowed by the turn in flight and never runs.
  const showAction = !busy && !exec && action;

  const summary = waiting
    ? 'Waiting on you'
    : exec ?? stripSummary(gsd);

  return (
    <>
      <div className={`gsd-bar${waiting ? ' gsd-bar--waiting' : ''}${exec ? ' gsd-bar--running' : ''}`}>
        <button
          className="gsd-bar-main"
          onClick={() => { setOpen(true); refreshGsd(sessionId); }}
          aria-label="Show GSD phases"
        >
          <span className="gsd-bar-chevron">{waiting ? '!' : exec ? '⟳' : '▸'}</span>
          <span className="gsd-bar-summary">{summary}</span>
          {!waiting && (
            <span className="gsd-bar-meter" aria-hidden="true">
              <span className="gsd-bar-meter-fill" style={{ width: `${pct}%` }} />
            </span>
          )}
        </button>

        {chips.map(c => (
          <button
            key={c.id}
            className="gsd-bar-action gsd-bar-action--recovery"
            onClick={() => run(c.command)}
            disabled={busy}
            title={busy ? 'Session is busy — wait for the current turn to finish' : c.command}
          >
            {c.label}
          </button>
        ))}

        {showAction && (
          <button
            className="gsd-bar-action"
            onClick={() => run(action.command)}
            title={action.command}
          >
            {action.label}
          </button>
        )}
      </div>

      {open && (
        <GsdStagePanel
          sessionId={sessionId}
          gsd={gsd}
          onRun={run}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
