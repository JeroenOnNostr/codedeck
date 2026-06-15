import { useState } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import UsagePanel from './UsagePanel';
import '../styles/header.css';

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

/**
 * Compact subscription-usage chip for the session header. Renders nothing unless the
 * feature flag is on, the serving bridge supports usage (protocol gate handled by the
 * caller passing `enabled`), and the bridge reported `available` usage (subscription session).
 * Tapping opens the full UsagePanel.
 */
export default function UsageBadge({ sessionId, enabled }: { sessionId: string; enabled: boolean }) {
  const show = useSessionStore((s) => s.config.show_usage_badge);
  const usage = useSessionStore((s) => s.remoteSessionUsage[sessionId]);
  const [open, setOpen] = useState(false);

  if (!show || !enabled || !usage || !usage.available) { return null; }

  // Need at least one window with a value to render a meaningful badge.
  const fiveHour = usage.fiveHour?.utilization;
  const sevenDay = usage.sevenDay?.utilization;
  if (typeof fiveHour !== 'number' && typeof sevenDay !== 'number') { return null; }

  const sev = severity(fiveHour, sevenDay, usage.sevenDayOpus?.utilization, usage.sevenDaySonnet?.utilization);

  return (
    <>
      <button
        className={`header-usage-badge${sev}`}
        onClick={() => setOpen(true)}
        title="Subscription usage — tap for detail"
        aria-label="Subscription usage"
      >
        5h {pct(fiveHour)} · wk {pct(sevenDay)}
      </button>
      {open && <UsagePanel sessionId={sessionId} usage={usage} onClose={() => setOpen(false)} />}
    </>
  );
}
