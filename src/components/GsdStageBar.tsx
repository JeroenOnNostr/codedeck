import { useState } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { stripSummary, recommendedAction } from '../utils/gsdStages';
import GsdStagePanel from './GsdStagePanel';
import '../styles/gsd.css';

/**
 * Collapsed GSD stage strip, pinned under the SessionHeader for remote sessions.
 *
 * GSD is command-driven — there are no hooks and no ambient UI — so driving a workflow from a
 * phone otherwise means remembering which phase you're on and typing `/gsd-execute-phase 2` on a
 * touch keyboard. This strip answers "where am I" in one line and turns the next step into one tap.
 *
 * It renders NOTHING unless the bridge reported a GSD project for this session, so ordinary
 * sessions are completely unaffected. `available: false` is a real answer from the bridge (not just
 * a missing snapshot), which is what lets the strip disappear again if a session leaves GSD.
 */
export default function GsdStageBar({ sessionId }: { sessionId: string }) {
  const gsd = useSessionStore((s) => s.remoteSessionGsd[sessionId]);
  const sendMessage = useSessionStore((s) => s.sendMessage);
  const refreshGsd = useSessionStore((s) => s.refreshGsd);
  const [open, setOpen] = useState(false);

  if (!gsd?.available) return null;

  const action = recommendedAction(gsd);
  const pct = Math.max(0, Math.min(100, gsd.percent));

  const run = (command: string) => {
    // Same path as typing it — the command shows up in the stream, so a tap is never invisible.
    // No refresh here: GSD state only moves once the command finishes, and MainPanel re-polls
    // on turn end.
    void sendMessage(sessionId, command);
    setOpen(false);
  };

  return (
    <>
      <div className="gsd-bar">
        <button
          className="gsd-bar-main"
          onClick={() => { setOpen(true); refreshGsd(sessionId); }}
          aria-label="Show GSD phases"
        >
          <span className="gsd-bar-chevron">▸</span>
          <span className="gsd-bar-summary">{stripSummary(gsd)}</span>
          <span className="gsd-bar-meter" aria-hidden="true">
            <span className="gsd-bar-meter-fill" style={{ width: `${pct}%` }} />
          </span>
        </button>

        {action && (
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
