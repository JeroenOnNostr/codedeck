import { useMemo, useRef, useState, useEffect } from 'react';
import { Session, RemoteSessionInfo } from '../types';
import { useUIStore } from '../stores/uiStore';
import { useSessionStore } from '../stores/sessionStore';
import { useVoiceModeStore } from '../stores/voiceModeStore';
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
  const configModel = useSessionStore((s) => s.config.model);
  const voiceEnabled = useVoiceModeStore((s) => s.enabled);
  const setVoiceEnabled = useVoiceModeStore((s) => s.setEnabled);
  const speaking = useVoiceModeStore((s) => s.speaking);
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

      {sessionId && (
        <button
          className={`header-btn header-voice${voiceEnabled ? ' voice-active' : ''}${speaking ? ' voice-speaking' : ''}`}
          onClick={() => setVoiceEnabled(!voiceEnabled)}
          aria-label={voiceEnabled ? 'Disable voice mode' : 'Enable voice mode'}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            {voiceEnabled ? (
              <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
            ) : (
              <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
            )}
          </svg>
        </button>
      )}

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
                  <span>{gsdEnabled ? 'Hide GSD setup' : 'Enable GSD for this session'}</span>
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
