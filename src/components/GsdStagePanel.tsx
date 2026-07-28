import type { GsdState } from '../types';
import { phaseStages, situationLabel } from '../utils/gsdStages';
import '../styles/modal.css';
import '../styles/gsd.css';

/**
 * Expanded GSD stage sheet — the full roadmap with per-phase Discuss/Plan/Execute marks, plus
 * the actions GSD recommends next. Every row with a command is tappable and sends it as ordinary
 * session input.
 *
 * Phase rows come from `init.manager`, which supplies per-phase commands already in the flat
 * `/gsd-execute-phase 2` form; the workflow-level actions come from `smart-entry` and were
 * normalized bridge-side. Either way what lands here is ready to send verbatim.
 */
export default function GsdStagePanel({
  gsd,
  onRun,
  onClose,
}: {
  sessionId: string;
  gsd: GsdState;
  onRun: (command: string) => void;
  onClose: () => void;
}) {
  const pct = Math.max(0, Math.min(100, gsd.percent));

  return (
    <div className="modal-overlay bottom-sheet" onClick={onClose}>
      <div className="modal-content bottom-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">
            {gsd.milestone || 'GSD'}
            <span className="gsd-situation-badge">{situationLabel(gsd.situation)}</span>
          </div>
          <div className="modal-close" onClick={onClose}>&times;</div>
        </div>

        {gsd.summary && <div className="gsd-summary">{gsd.summary}</div>}

        <div className="gsd-meter">
          <div className="gsd-meter-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="gsd-meter-caption">{pct}% of plans complete</div>

        {gsd.phases.length > 0 && (
          <div className="gsd-phases">
            <div className="gsd-phases-head">
              <span>Phase</span>
              {/* Discuss / Plan / Execute — the same three columns /gsd-manager shows. */}
              <span className="gsd-stage-key">D&nbsp;P&nbsp;E</span>
            </div>

            {gsd.phases.map((p) => {
              const { marks, label } = phaseStages(p);
              const current = gsd.currentPhase === p.number;
              const tappable = !!p.command;
              return (
                <button
                  key={p.number}
                  className={`gsd-phase-row${current ? ' gsd-phase-row--current' : ''}`}
                  disabled={!tappable}
                  onClick={() => p.command && onRun(p.command)}
                  title={p.command ?? undefined}
                >
                  <span className="gsd-phase-num">{p.number}</span>
                  <span className="gsd-phase-name">
                    {p.name}
                    <span className="gsd-phase-status">
                      {label}
                      {p.plans > 0 && ` · ${p.summaries}/${p.plans} plans`}
                    </span>
                  </span>
                  <span className="gsd-phase-marks" aria-label={label}>
                    {marks.map((m, i) => (
                      <span key={i} className={`gsd-mark gsd-mark--${m === '✓' ? 'done' : m === '◆' ? 'active' : m === '○' ? 'ready' : 'todo'}`}>
                        {m}
                      </span>
                    ))}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {gsd.actions.length > 0 && (
          <div className="gsd-actions">
            <div className="gsd-actions-head">Next</div>
            {gsd.actions.map((a) => (
              <button
                key={a.id}
                className={`gsd-action-row${a.recommended ? ' gsd-action-row--recommended' : ''}`}
                onClick={() => onRun(a.command)}
              >
                <span className="gsd-action-label">{a.label}</span>
                <span className="gsd-action-cmd">{a.command}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
