import { useCallback, useEffect, useMemo } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { useDmStore } from '../stores/dmStore';
import { useUIStore } from '../stores/uiStore';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useSwipeToNavigate } from '../hooks/useSwipeToNavigate';
import { useOrderedSessionIds } from '../hooks/useOrderedSessionIds';
import { useVoiceMode } from '../hooks/useVoiceMode';
import { cycleIndex } from '../utils/cycleIndex';
import { RemoteSessionInfo } from '../types';
import SessionHeader from './SessionHeader';
import OutputStream from './OutputStream';
import PermissionBar from './PermissionBar';
import RemotePermissionBar from './RemotePermissionBar';
import InputBar from './InputBar';
import DmConversationView from './DmConversationView';
import ErrorBoundary from './ErrorBoundary';

/** Isolated component so useVoiceMode can sit inside an ErrorBoundary.
 *  If voice mode crashes, the rest of MainPanel keeps working. */
function VoiceModeRunner() {
  useVoiceMode();
  return null;
}

export default function MainPanel({ isWide }: { isWide: boolean }) {
  const panelMode = useUIStore((s) => s.panelMode);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const activeConversationId = useDmStore((s) => s.activeConversationId);
  const conversations = useDmStore((s) => s.conversations);
  const setActiveConversation = useDmStore((s) => s.setActiveConversation);
  const remoteSessions = useSessionStore((s) => s.remoteSessions);
  const remoteSessionModes = useSessionStore((s) => s.remoteSessionModes);
  const remoteSessionEffort = useSessionStore((s) => s.remoteSessionEffort);
  const machineProtocolVersion = useSessionStore((s) => s.machineProtocolVersion);
  const defaultMode = useSessionStore((s) => s.config.default_mode);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const requestSessionHistory = useSessionStore((s) => s.requestSessionHistory);
  const refreshUsage = useSessionStore((s) => s.refreshUsage);
  const setPanelMode = useUIStore((s) => s.setPanelMode);
  const retryOptimisticSession = useSessionStore((s) => s.retryOptimisticSession);
  // Reactive status of the active optimistic session, if any (drives the retry banner).
  const optimisticStatus = useSessionStore((s) => {
    const id = s.activeSessionId;
    if (!id || !id.startsWith('optimistic:')) return null;
    return s.optimisticSessions.get(id.slice('optimistic:'.length))?.status ?? null;
  });
  const isTouchDevice = useMediaQuery('(pointer: coarse)');

  const handleRetryOptimistic = useCallback(() => {
    const id = useSessionStore.getState().activeSessionId;
    if (id && id.startsWith('optimistic:')) {
      retryOptimisticSession(id.slice('optimistic:'.length));
    }
  }, [retryOptimisticSession]);

  const orderedIds = useOrderedSessionIds();

  const navigateSession = useCallback((direction: 'next' | 'prev') => {
    if (orderedIds.length <= 1 || !activeSessionId) return;
    const currentIndex = orderedIds.indexOf(activeSessionId);
    if (currentIndex === -1) return;

    const newIndex = direction === 'next' ? currentIndex + 1 : currentIndex - 1;
    if (newIndex < 0 || newIndex >= orderedIds.length) return;
    const newSessionId = orderedIds[newIndex];
    setActiveSession(newSessionId);
    setPanelMode('session');

    // Only request history for remote sessions without output
    const state = useSessionStore.getState();
    const isLocal = state.sessions.some(s => s.id === newSessionId);
    if (!isLocal && (state.outputs[newSessionId]?.length ?? 0) === 0) {
      requestSessionHistory(newSessionId);
    }
  }, [orderedIds, activeSessionId, setActiveSession, setPanelMode, requestSessionHistory]);

  // Ordered conversation IDs — sorted by most recent message (same order as sidebar)
  const orderedConvIds = useMemo(
    () => [...conversations]
      .sort((a, b) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime())
      .map(c => c.id),
    [conversations],
  );

  const navigateConversation = useCallback((direction: 'next' | 'prev') => {
    if (orderedConvIds.length <= 1 || !activeConversationId) return;
    const currentIndex = orderedConvIds.indexOf(activeConversationId);
    if (currentIndex === -1) return;

    setActiveConversation(orderedConvIds[cycleIndex(currentIndex, orderedConvIds.length, direction === 'next' ? 1 : -1)]);
  }, [orderedConvIds, activeConversationId, setActiveConversation]);

  // Whether swiping is possible in each direction (sessions have edges, DMs wrap)
  const canSwipeLeft = useMemo(() => {
    if (panelMode === 'dm') return true;
    if (orderedIds.length <= 1 || !activeSessionId) return false;
    const idx = orderedIds.indexOf(activeSessionId);
    return idx !== -1 && idx < orderedIds.length - 1;
  }, [panelMode, orderedIds, activeSessionId]);

  const canSwipeRight = useMemo(() => {
    if (panelMode === 'dm') return true;
    if (orderedIds.length <= 1 || !activeSessionId) return false;
    const idx = orderedIds.indexOf(activeSessionId);
    return idx !== -1 && idx > 0;
  }, [panelMode, orderedIds, activeSessionId]);

  const { containerRef, touchHandlers } = useSwipeToNavigate({
    onSwipeLeft: () => panelMode === 'dm' ? navigateConversation('next') : navigateSession('next'),
    onSwipeRight: () => panelMode === 'dm' ? navigateConversation('prev') : navigateSession('prev'),
    enabled: isTouchDevice && (panelMode === 'session' || panelMode === 'dm'),
    canSwipeLeft,
    canSwipeRight,
  });

  // Find remote session info if not a local session
  let remoteSession: RemoteSessionInfo | undefined;
  let remoteMachineKey: string | undefined;
  if (activeSessionId && !activeSession) {
    for (const [machineKey, sessions] of Object.entries(remoteSessions)) {
      remoteSession = sessions?.find(s => s.id === activeSessionId);
      if (remoteSession) { remoteMachineKey = machineKey; break; }
    }
  }

  // Tracked mode for remote session, defaulting to config's default_mode
  const remoteMode = remoteSession
    ? (remoteSessionModes[remoteSession.id] ?? defaultMode)
    : undefined;
  const remoteEffort = remoteSession
    ? (remoteSessionEffort[remoteSession.id] ?? 'auto')
    : undefined;
  // Usage snapshots are a protocol v3+ feature. Gate the header badge so older bridges stay silent.
  const bridgeSupportsUsage = remoteMachineKey
    ? (machineProtocolVersion[remoteMachineKey] ?? 0) >= 3
    : false;

  // Pull a fresh usage snapshot whenever a usage-capable remote session becomes active, so the
  // badge shows a current value immediately on open (the bridge also pushes on its 60s heartbeat).
  const remoteSessionId = remoteSession?.id;
  useEffect(() => {
    if (remoteSessionId && bridgeSupportsUsage) {
      refreshUsage(remoteSessionId);
    }
  }, [remoteSessionId, bridgeSupportsUsage, refreshUsage]);

  return (
    <div
      ref={containerRef}
      {...touchHandlers}
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        height: 'var(--app-height, 100%)',
        minWidth: 0,
        background: 'var(--bg-black)',
      }}
    >
      <ErrorBoundary><VoiceModeRunner /></ErrorBoundary>
      <ErrorBoundary>
      {panelMode === 'dm' && activeConversationId ? (
        <DmConversationView conversationId={activeConversationId} isWide={isWide} />
      ) : panelMode === 'session' && activeSession ? (
        <>
          <SessionHeader session={activeSession} isWide={isWide} />
          <OutputStream sessionId={activeSession.id} />
          {activeSession.state === 'waiting_permission' && activeSession.pending_permissions.length > 0 && (
            <PermissionBar session={activeSession} />
          )}
          <InputBar sessionId={activeSession.id} mode={activeSession.mode} effort={undefined} />
        </>
      ) : panelMode === 'session' && remoteSession ? (
        <>
          <SessionHeader remoteSession={remoteSession} isWide={isWide} bridgeSupportsUsage={bridgeSupportsUsage} />
          <OutputStream sessionId={remoteSession.id} />
          {optimisticStatus === 'failed' && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              padding: '10px 14px',
              margin: '0 12px 8px',
              borderRadius: 8,
              background: 'var(--bg-error, rgba(220, 38, 38, 0.12))',
              border: '1px solid var(--border-error, rgba(220, 38, 38, 0.4))',
              fontSize: 13,
            }}>
              <span style={{ color: 'var(--text-muted)' }}>Couldn’t start the session.</span>
              <button className="modal-secondary-btn" style={{ padding: '6px 14px', margin: 0 }} onClick={handleRetryOptimistic}>
                Retry
              </button>
            </div>
          )}
          <RemotePermissionBar sessionId={remoteSession.id} />
          <InputBar sessionId={remoteSession.id} mode={remoteMode} effort={remoteEffort} />
        </>
      ) : (
        <>
          <SessionHeader isWide={isWide} />
          <div style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-muted)',
            fontSize: 15,
          }}>
            Select or create a session to get started
          </div>
        </>
      )}
      </ErrorBoundary>
    </div>
  );
}
