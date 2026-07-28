import { useState } from 'react';
import { useSessionStore } from '../stores/sessionStore';
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
  const [open, setOpen] = useState(false);

  if (!gsd) return null;
  // Not a GSD project: only visible once opted in, and only when GSD could actually do something.
  const setupMode = !gsd.available;
  if (setupMode && !(enabled && gsd.installed)) return null;

  const run = (command: string) => {
    // Same path as typing it — the command shows up in the stream, so a tap is never invisible.
    // No refresh here: GSD state only moves once the command finishes, and MainPanel re-polls
    // on turn end.
    void sendMessage(sessionId, command);
    setOpen(false);
  };

  // --- Setup mode: this project isn't a GSD project yet ---
  if (setupMode) {
    const start = gsd.actions.find(a => a.id === 'new-project');
    const map = gsd.actions.find(a => a.id === 'map-codebase');
    return (
      <div className="gsd-bar gsd-bar--setup">
        <span className="gsd-bar-summary gsd-bar-summary--muted">GSD not set up here</span>
        {map && (
          <button className="gsd-bar-action" onClick={() => run(map.command)} title={map.command}>
            Map codebase
          </button>
        )}
        {start && (
          <button className="gsd-bar-action gsd-bar-action--primary" onClick={() => run(start.command)} title={start.command}>
            Start GSD
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
  const showAction = !waiting && !exec && action;

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
            title={c.command}
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
