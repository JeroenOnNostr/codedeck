import { useEffect, useState } from 'react';
import { UsageData, UsageWindow } from '../types';
import { useSessionStore } from '../stores/sessionStore';
import '../styles/modal.css';

/** Format an ISO reset timestamp as a coarse countdown, e.g. "resets in 3h 12m". */
function formatReset(resetsAt: string | null, nowMs: number): string | null {
  if (!resetsAt) { return null; }
  const target = Date.parse(resetsAt);
  if (!Number.isFinite(target)) { return null; }
  const diffMs = target - nowMs;
  if (diffMs <= 0) { return 'resetting…'; }
  const totalMin = Math.floor(diffMs / 60_000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) { return `resets in ${days}d ${hours}h`; }
  if (hours > 0) { return `resets in ${hours}h ${mins}m`; }
  return `resets in ${mins}m`;
}

/** Coarse "as of" label for the snapshot freshness. */
function formatAsOf(fetchedAt: string, nowMs: number): string {
  const t = Date.parse(fetchedAt);
  if (!Number.isFinite(t)) { return ''; }
  const ageSec = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (ageSec < 60) { return 'just now'; }
  const min = Math.floor(ageSec / 60);
  if (min < 60) { return `${min}m ago`; }
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

function severityClass(util: number | null): string {
  if (util === null) { return ''; }
  if (util >= 90) { return ' usage-row--critical'; }
  if (util >= 75) { return ' usage-row--warning'; }
  return '';
}

function UsageRow({ label, window: w, nowMs }: { label: string; window?: UsageWindow; nowMs: number }) {
  if (!w || w.utilization === null) { return null; }
  const util = Math.max(0, Math.min(100, w.utilization));
  const reset = formatReset(w.resetsAt, nowMs);
  return (
    <div className={`usage-row${severityClass(w.utilization)}`}>
      <div className="usage-row-head">
        <span className="usage-row-label">{label}</span>
        <span className="usage-row-pct">{Math.round(util)}%</span>
      </div>
      <div className="usage-bar">
        <div className="usage-bar-fill" style={{ width: `${util}%` }} />
      </div>
      {reset && <div className="usage-row-reset">{reset}</div>}
    </div>
  );
}

/** Detail sheet for subscription usage — every reported window + reset countdowns. */
export default function UsagePanel({ sessionId, usage, onClose }: { sessionId: string; usage: UsageData; onClose: () => void }) {
  const refreshUsage = useSessionStore((s) => s.refreshUsage);
  // Tick once a minute so countdowns/“as of” stay roughly live while open.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const anyWindow = usage.fiveHour || usage.sevenDay || usage.sevenDayOpus || usage.sevenDaySonnet;

  return (
    <div className="modal-overlay bottom-sheet" onClick={onClose}>
      <div className="modal-content bottom-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">
            Subscription usage
            {usage.subscriptionType && (
              <span className="usage-plan-badge">{usage.subscriptionType.toUpperCase()}</span>
            )}
          </div>
          <div className="modal-close" onClick={onClose}>&times;</div>
        </div>

        {anyWindow ? (
          <div className="usage-rows">
            <UsageRow label="Session (5h)" window={usage.fiveHour} nowMs={nowMs} />
            <UsageRow label="Weekly (all models)" window={usage.sevenDay} nowMs={nowMs} />
            <UsageRow label="Weekly · Opus" window={usage.sevenDayOpus} nowMs={nowMs} />
            <UsageRow label="Weekly · Sonnet" window={usage.sevenDaySonnet} nowMs={nowMs} />
          </div>
        ) : (
          <div className="modal-hint">No usage windows reported yet.</div>
        )}

        <div className="usage-footer">
          {typeof usage.sessionCostUsd === 'number' && usage.sessionCostUsd > 0 && (
            <span className="usage-cost">Session cost ${usage.sessionCostUsd.toFixed(2)}</span>
          )}
          <span className="usage-asof">Updated {formatAsOf(usage.fetchedAt, nowMs)}</span>
        </div>

        <button className="usage-refresh-btn" onClick={() => refreshUsage(sessionId)}>
          Refresh
        </button>
      </div>
    </div>
  );
}
