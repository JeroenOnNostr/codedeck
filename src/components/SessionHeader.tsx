import { useMemo, useRef, useState, useEffect } from 'react';
import { Session, RemoteSessionInfo } from '../types';
import { useUIStore } from '../stores/uiStore';
import { useSessionStore } from '../stores/sessionStore';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useOrderedSessionIds } from '../hooks/useOrderedSessionIds';
import { sessionNeedsAttention } from '../utils/sessionNeedsAttention';
import { modelLabel, modelContextWindow } from '../constants/models';
import UsageBadge from './UsageBadge';
import '../styles/header.css';

/**
 * Context-window occupancy as an integer % of the model's max, or null if unknown.
 * Prefers the real window the bridge advertised (`windowOverride`, from the SDK's resolved
 * `contextWindow` — honest about the active 1M beta); falls back to guessing from the model id
 * only when the bridge didn't report one (older protocol / before the first result message).
 */
function contextPct(
  contextTokens: number | undefined,
  modelId: string | undefined,
  windowOverride: number | undefined,
): number | null {
  if (typeof contextTokens !== 'number' || contextTokens <= 0) { return null; }
  const max = (typeof windowOverride === 'number' && windowOverride > 0)
    ? windowOverride
    : modelContextWindow(modelId);
  return Math.min(100, Math.round((contextTokens / max) * 100));
}

/**
 * Checks if any session in the given direction needs attention
 * (unread or waiting_permission).
 */
function useAttentionDirection(sessionId: string | undefined) {
  const orderedIds = useOrderedSessionIds();
  const sessions = useSessionStore((s) => s.sessions);
  const machines = useSessionStore((s) => s.machines);
  const remoteSessions = useSessionStore((s) => s.remoteSessions);
  const unreadSessions = useSessionStore((s) => s.unreadSessions);

  return useMemo(() => {
    if (!sessionId) return { left: false, right: false };

    const currentIndex = orderedIds.indexOf(sessionId);
    if (currentIndex === -1 || orderedIds.length <= 1) return { left: false, right: false };

    // Flatten state for every session (local + remote) so the shared predicate sees
    // the real waiting_* state for bridge sessions too — not just unread. Matches the
    // sidebar's attention dot exactly.
    const stateById = new Map<string, Session['state'] | RemoteSessionInfo['state']>();
    for (const s of sessions) stateById.set(s.id, s.state);
    for (const machine of machines) {
      for (const rs of remoteSessions[machine.pubkeyHex] || []) {
        if (rs.state) stateById.set(rs.id, rs.state);
      }
    }

    const needsAttention = (id: string) =>
      sessionNeedsAttention(stateById.get(id), unreadSessions.has(id));

    // Left = previous sessions (indices before current)
    let left = false;
    for (let i = 0; i < currentIndex; i++) {
      if (needsAttention(orderedIds[i])) { left = true; break; }
    }

    // Right = next sessions (indices after current)
    let right = false;
    for (let i = currentIndex + 1; i < orderedIds.length; i++) {
      if (needsAttention(orderedIds[i])) { right = true; break; }
    }

    return { left, right };
  }, [sessionId, orderedIds, sessions, machines, remoteSessions, unreadSessions]);
}

export default function SessionHeader({ session, remoteSession, isWide, bridgeSupportsUsage }: { session?: Session; remoteSession?: RemoteSessionInfo; isWide: boolean; bridgeSupportsUsage?: boolean }) {
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const sessionId = session?.id ?? remoteSession?.id;
  const contextTokens = useSessionStore((s) => sessionId ? s.remoteSessionContext[sessionId] : undefined);
  const liveModel = useSessionStore((s) => sessionId ? s.remoteSessionModel[sessionId] : undefined);
  // Real context window the bridge advertised (protocol v4+) — the honest %-badge denominator.
  const liveContextWindow = useSessionStore((s) => sessionId ? s.remoteSessionContextWindow[sessionId] : undefined);
  // Authoritative context-usage % the bridge read straight from the SDK (protocol v5+) — the same
  // meter the Claude Code terminal shows. Preferred over computing tokens/window ourselves.
  const liveContextPercentage = useSessionStore((s) => sessionId ? s.remoteSessionContextPercentage[sessionId] : undefined);
  const remoteGsd = useSessionStore((s) => sessionId ? s.remoteSessionGsd[sessionId] : undefined);
  const gsdEnabled = useSessionStore((s) => sessionId ? s.gsdEnabledSessions[sessionId] === true : false);
  const setGsdEnabled = useSessionStore((s) => s.setGsdEnabled);
  const machine = useSessionStore((s) => sessionId ? s.getMachineForSession(sessionId) : undefined);
  const setNewSessionOpen = useUIStore((s) => s.setNewSessionOpen);
  const configModel = useSessionStore((s) => s.config.model);
  const isTouchDevice = useMediaQuery('(pointer: coarse)');
  const attention = useAttentionDirection(sessionId);
  const sendMessage = useSessionStore((s) => s.sendMessage);

  // /compact summarizes the conversation to relieve context pressure on long sessions.
  // Input is passed verbatim to the SDK by the bridge, so sending the slash command works
  // exactly as typing it would. Only offered for remote (bridge-backed) sessions.
  const handleCompact = () => {
    if (!remoteSession) return;
    void sendMessage(remoteSession.id, '/compact');
  };

  // Overflow (⋯) menu — home for rarely-used, remote-only actions (currently just /compact),
  // keeping them off the top-level header so the title has room. Closes on outside tap / Escape.
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!overflowOpen) return;
    const onDocPointer = (e: PointerEvent) => {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
        setOverflowOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOverflowOpen(false); };
    document.addEventListener('pointerdown', onDocPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDocPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [overflowOpen]);

  return (
    <div className="session-header">
      {isTouchDevice && attention.left && (
        <span className="session-nav-hint left" aria-hidden="true">{'\u2039'}</span>
      )}
      {isTouchDevice && attention.right && (
        <span className="session-nav-hint right" aria-hidden="true">{'\u203A'}</span>
      )}
      {!isWide && (
        <button className="header-btn header-hamburger" onClick={() => setSidebarOpen(true)}>
          &#9776;
        </button>
      )}

      <button className="header-btn header-settings" onClick={() => setSettingsOpen(true)}>
        &#9881;
      </button>

      {remoteSession && (
        <div className="header-overflow" ref={overflowRef}>
          <button
            className="header-btn header-overflow-btn"
            onClick={() => setOverflowOpen((o) => !o)}
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={overflowOpen}
            title="More actions"
          >
            {/* horizontal meatball (⋯) icon */}
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
              <path d="M6 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/>
            </svg>
          </button>
          {overflowOpen && (
            <div className="header-overflow-menu" role="menu">
              {/* CD-058. The direct route to what the whole GSD strip exists for: a brand-new
                  project, in its own folder, with the workflow already running. Offered from any
                  session so it never depends on standing in the right directory first. */}
              {remoteGsd?.installed && (
                <button
                  className="header-overflow-item"
                  role="menuitem"
                  onClick={() => { setNewSessionOpen(true, machine ?? null, true); setOverflowOpen(false); }}
                  title="Create a project folder and start the GSD workflow in it"
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                    <path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5z"/>
                  </svg>
                  <span>New GSD project…</span>
                </button>
              )}
              {/* GSD is opt-in PER SESSION: a project that already has .planning/ shows the strip
                  on its own, so this only matters for turning a fresh project into a GSD one. */}
              {remoteGsd?.installed && !remoteGsd.available && (
                <button
                  className="header-overflow-item"
                  role="menuitem"
                  onClick={() => { setGsdEnabled(remoteSession.id, !gsdEnabled); setOverflowOpen(false); }}
                  title="Show GSD setup actions for this session"
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                    <path d="M4 5h16v2H4V5zm0 6h10v2H4v-2zm0 6h16v2H4v-2z"/>
                  </svg>
                  <span>{gsdEnabled ? 'Hide GSD setup' : 'Set up GSD in this project'}</span>
                </button>
              )}
              <button
                className="header-overflow-item"
                role="menuitem"
                onClick={() => { handleCompact(); setOverflowOpen(false); }}
                title="Compact conversation (/compact) — summarize history to free up context"
              >
                {/* compress / merge-to-center icon */}
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                  <path d="M4 9h4V5h2v6H4V9zm10 0V5h2v4h4v2h-6V9zM4 13h6v6H8v-4H4v-2zm10 0h6v2h-4v4h-2v-6z"/>
                </svg>
                <span>Compact conversation</span>
              </button>
            </div>
          )}
        </div>
      )}

      {session ? (
        <>
          <div className="header-info">
            <div className="header-title">
              {session.name}
              {!session.workspace_ready && (
                <span className="header-cloning"> (cloning...)</span>
              )}
            </div>
            <div className="header-subtitle">
              {session.group}:{session.workspace_path} · {session.branch}
            </div>
          </div>
        </>
      ) : remoteSession ? (
        <>
          <div className="header-info">
            <div className="header-title">{remoteSession.title || remoteSession.slug}</div>
            <div className="header-subtitle">
              {remoteSession.state === 'waiting_permission'
                ? <span className="header-waiting-pill">Waiting for approval</span>
                : remoteSession.state === 'waiting_question'
                ? <span className="header-waiting-pill">Waiting for your answer</span>
                : (remoteSession.project || remoteSession.cwd)}
            </div>
          </div>
          <div className="header-meta">
            <span className="header-model-badge">
              {modelLabel(liveModel ?? remoteSession.model ?? configModel)}
              {(() => {
                // Prefer the SDK's authoritative % (protocol v5+) — matches the Claude Code terminal
                // and avoids the tokens/window reconstruction that jumps. Fall back to the local
                // computation for older (pre-v5) bridges.
                const advertised = liveContextPercentage ?? remoteSession.contextPercentage;
                const ctx = typeof advertised === 'number'
                  ? advertised
                  : contextPct(contextTokens, liveModel ?? remoteSession.model ?? configModel, liveContextWindow ?? remoteSession.contextWindow);
                return ctx !== null ? <span className="header-context-pct"> · {ctx}%</span> : null;
              })()}
            </span>
            <UsageBadge enabled={!!bridgeSupportsUsage} />
          </div>
        </>
      ) : (
        <div className="header-placeholder">CodeDeck</div>
      )}
    </div>
  );
}
