import { useEffect, useState } from 'react';
import { UsageData } from '../types';
import { useSessionStore } from '../stores/sessionStore';
import UsagePanel from './UsagePanel';
import '../styles/header.css';

/**
 * Subscription rate limits are account-global, not per-session. Each session only
 * caches the snapshot it last received from the bridge (on heartbeat/request), so
 * those snapshots reflect the same global limits as of different moments. To keep
 * the badge from jumping around as you cycle sessions, pick the freshest snapshot
 * across all sessions by `fetchedAt` rather than the current session's stale copy.
 */
function freshestUsage(bySession: Record<string, UsageData>): { sessionId: string; usage: UsageData } | null {
  let best: { sessionId: string; usage: UsageData } | null = null;
  let bestMs = -Infinity;
  for (const [sessionId, usage] of Object.entries(bySession)) {
    if (!usage || !usage.available) { continue; }
    const ms = Date.parse(usage.fetchedAt);
    const t = Number.isFinite(ms) ? ms : -Infinity;
    if (t >= bestMs) { bestMs = t; best = { sessionId, usage }; }
  }
  return best;
}

/** Pick the badge severity from the worst utilization across reported windows. */
function severity(...utils: Array<number | null | undefined>): '' | ' usage-warning' | ' usage-critical' {
  const max = utils.reduce<number>((m, u) => (typeof u === 'number' && u > m ? u : m), 0);
  if (max >= 90) { return ' usage-critical'; }
  if (max >= 75) { return ' usage-warning'; }
  return '';
}

function pct(u: number | null | undefined): string {
  return typeof u === 'number' ? `${Math.round(u)}%` : '—';
}

/** Very short reset countdown for the chip, e.g. "3h12m", "2d4h", "8m". Empty if unknown/elapsed. */
function shortReset(resetsAt: string | null | undefined, nowMs: number): string {
  if (!resetsAt) { return ''; }
  const target = Date.parse(resetsAt);
  if (!Number.isFinite(target)) { return ''; }
  const diffMs = target - nowMs;
  if (diffMs <= 0) { return 'now'; }
  const totalMin = Math.floor(diffMs / 60_000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) { return `${days}d${hours}h`; }
  if (hours > 0) { return `${hours}h${mins}m`; }
  return `${mins}m`;
}

/**
 * Compact subscription-usage chip for the session header. Renders nothing unless the
 * feature flag is on, the serving bridge supports usage (protocol gate handled by the
 * caller passing `enabled`), and the bridge reported `available` usage (subscription session).
 * Tapping opens the full UsagePanel.
 */
export default function UsageBadge({ enabled }: { sessionId?: string; enabled: boolean }) {
  const show = useSessionStore((s) => s.config.show_usage_badge);
  const bySession = useSessionStore((s) => s.remoteSessionUsage);
  const [open, setOpen] = useState(false);
  // Tick once a minute so the inline reset countdowns stay roughly live.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  // Global indicator: show the freshest snapshot across all sessions, not the
  // current session's (which may be a stale copy of the same global limits).
  const freshest = freshestUsage(bySession);
  if (!show || !enabled || !freshest) { return null; }
  const { sessionId, usage } = freshest;

  // Need at least one window with a value to render a meaningful badge.
  const fiveHour = usage.fiveHour?.utilization;
  const sevenDay = usage.sevenDay?.utilization;
  if (typeof fiveHour !== 'number' && typeof sevenDay !== 'number') { return null; }

  const sev = severity(fiveHour, sevenDay, usage.sevenDayOpus?.utilization, usage.sevenDaySonnet?.utilization);
  const fiveHourReset = shortReset(usage.fiveHour?.resetsAt, nowMs);
  const sevenDayReset = shortReset(usage.sevenDay?.resetsAt, nowMs);

  return (
    <>
      <button
        className={`header-usage-badge${sev}`}
        onClick={() => setOpen(true)}
        title="Subscription usage (with time until reset) — tap for detail"
        aria-label="Subscription usage"
      >
        <span className="usage-badge-row">5h {pct(fiveHour)}{fiveHourReset && <span className="usage-badge-reset"> {fiveHourReset}</span>}</span>
        <span className="usage-badge-row">wk {pct(sevenDay)}{sevenDayReset && <span className="usage-badge-reset"> {sevenDayReset}</span>}</span>
      </button>
      {open && <UsagePanel sessionId={sessionId} usage={usage} onClose={() => setOpen(false)} />}
    </>
  );
}
