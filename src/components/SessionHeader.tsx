import { useMemo } from 'react';
import { Session, TokenUsage, RemoteSessionInfo } from '../types';
import { useUIStore } from '../stores/uiStore';
import { useSessionStore } from '../stores/sessionStore';
import { useVoiceModeStore } from '../stores/voiceModeStore';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useOrderedSessionIds } from '../hooks/useOrderedSessionIds';
import { modelLabel } from '../constants/models';
import UsageBadge from './UsageBadge';
import '../styles/header.css';

function formatTokens(usage: TokenUsage): string {
  const fmt = (n: number) => n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n);
  if (usage.total_cost_usd > 0) {
    return `${fmt(usage.input_tokens)} in / ${fmt(usage.output_tokens)} out · $${usage.total_cost_usd.toFixed(2)}`;
  }
  return `${fmt(usage.input_tokens)} in / ${fmt(usage.output_tokens)} out`;
}

/**
 * Checks if any session in the given direction needs attention
 * (unread or waiting_permission).
 */
function useAttentionDirection(sessionId: string | undefined) {
  const orderedIds = useOrderedSessionIds();
  const sessions = useSessionStore((s) => s.sessions);
  const unreadSessions = useSessionStore((s) => s.unreadSessions);

  return useMemo(() => {
    if (!sessionId) return { left: false, right: false };

    const currentIndex = orderedIds.indexOf(sessionId);
    if (currentIndex === -1 || orderedIds.length <= 1) return { left: false, right: false };

    const needsAttention = (id: string) => {
      if (unreadSessions.has(id)) return true;
      const local = sessions.find(s => s.id === id);
      if (local?.state === 'waiting_permission') return true;
      return false;
    };

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
  }, [sessionId, orderedIds, sessions, unreadSessions]);
}

export default function SessionHeader({ session, remoteSession, isWide, bridgeSupportsUsage }: { session?: Session; remoteSession?: RemoteSessionInfo; isWide: boolean; bridgeSupportsUsage?: boolean }) {
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const sessionId = session?.id ?? remoteSession?.id;
  const tokenUsage = useSessionStore((s) => sessionId ? s.tokenUsage[sessionId] : undefined);
  const liveModel = useSessionStore((s) => sessionId ? s.remoteSessionModel[sessionId] : undefined);
  const configModel = useSessionStore((s) => s.config.model);
  const voiceEnabled = useVoiceModeStore((s) => s.enabled);
  const setVoiceEnabled = useVoiceModeStore((s) => s.setEnabled);
  const speaking = useVoiceModeStore((s) => s.speaking);
  const isTouchDevice = useMediaQuery('(pointer: coarse)');
  const attention = useAttentionDirection(sessionId);

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
          {tokenUsage && (tokenUsage.input_tokens > 0 || tokenUsage.output_tokens > 0) && (
            <div className="header-meta">
              <div className="header-tokens">{formatTokens(tokenUsage)}</div>
            </div>
          )}
        </>
      ) : remoteSession ? (
        <>
          <div className="header-info">
            <div className="header-title">{remoteSession.title || remoteSession.slug}</div>
            <div className="header-subtitle">{remoteSession.project || remoteSession.cwd}</div>
          </div>
          <div className="header-meta">
            <span className="header-model-badge">{modelLabel(liveModel ?? remoteSession.model ?? configModel)}</span>
            <UsageBadge sessionId={remoteSession.id} enabled={!!bridgeSupportsUsage} />
            {tokenUsage && (tokenUsage.input_tokens > 0 || tokenUsage.output_tokens > 0) && (
              <div className="header-tokens">{formatTokens(tokenUsage)}</div>
            )}
          </div>
        </>
      ) : (
        <div className="header-placeholder">CodeDeck</div>
      )}
    </div>
  );
}
