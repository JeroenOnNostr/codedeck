import { useSessionStore } from '../stores/sessionStore';
import { usePendingRemotePermission } from '../hooks/useDisplayEntries';
import '../styles/permission.css';

/**
 * Pinned permission bar for REMOTE sessions, shown above the InputBar.
 *
 * Remote sessions have no PermissionBar (that one is for local Tauri sessions) — permission cards
 * only render inline in the OutputStream, where they get buried below a large collapsed sub-agent
 * group. A sub-agent's write-permission prompt going unseen is exactly what deadlocks a session, so
 * this bar always surfaces the latest still-pending permission. Answering here uses the same
 * respondRemotePermission + markCardResponded path as the inline card, so both clear together.
 */
export default function RemotePermissionBar({ sessionId }: { sessionId: string }) {
  const perm = usePendingRemotePermission(sessionId);
  const respondRemotePermission = useSessionStore((s) => s.respondRemotePermission);
  const markResponded = useSessionStore((s) => s.markCardResponded);

  if (!perm) return null;

  // Tool-specific "always" label: WebFetch/WebSearch use per-domain allowlists (mirrors the inline card).
  const isWebTool = perm.toolName === 'WebFetch' || perm.toolName === 'WebSearch';
  const alwaysLabel = isWebTool ? 'Allow domain' : 'Always';
  const originLabel = perm.isSubAgent
    ? `${perm.agentLabel ? `${perm.agentLabel} agent` : 'Sub-agent'} wants to run`
    : 'Permission needed';

  const respond = (allow: boolean, modifier?: 'always' | 'never') => {
    markResponded(sessionId, perm.requestId);
    respondRemotePermission(sessionId, perm.requestId, allow, modifier);
  };

  return (
    <div className="permission-bar" aria-live="polite">
      <div className="permission-header">
        <span className="permission-type">{perm.toolName}</span>
        <span className="permission-desc">{originLabel}</span>
      </div>

      {perm.description && <div className="permission-command">{perm.description}</div>}

      <div className="permission-actions">
        <button className="btn-allow" onClick={() => respond(true)}>Allow</button>
        <button className="btn-always" onClick={() => respond(true, 'always')}>{alwaysLabel}</button>
        <button className="btn-deny" onClick={() => respond(false)}>Deny</button>
      </div>
    </div>
  );
}
