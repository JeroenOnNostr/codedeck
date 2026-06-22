import { useState, useRef, useCallback, useEffect, useSyncExternalStore } from 'react';
import { useUIStore } from '../stores/uiStore';
import { useSessionStore } from '../stores/sessionStore';
import { useDmStore } from '../stores/dmStore';
import { useSwipeToDelete } from '../hooks/useSwipeToDelete';
import { parsePublicKey, getDebugInfo } from '../services/nostrService';
import { subscribe as debugSubscribe, getLogEntries, clearLog } from '../services/debugLog';
import { relativeTime } from '../utils/relativeTime';
import { sessionNeedsAttention } from '../utils/sessionNeedsAttention';
import { Session, RemoteSessionInfo } from '../types';
import DmTile from './DmTile';
import '../styles/sidebar.css';
import '../styles/dm.css';

const PULL_THRESHOLD = 60;
const MAX_PULL = 100;

function StatusDot({ state, isUnread }: { state: Session['state'] | RemoteSessionInfo['state']; isUnread: boolean }) {
  // One unmistakable dot for "needs me" — blocked on the user (plan/permission
  // approval or AskUserQuestion) OR unread. Solid + bold (see .attention-dot);
  // shows even on the foreground/active session.
  if (sessionNeedsAttention(state, isUnread)) {
    return <div className="attention-dot" aria-label="Needs attention" />;
  }
  // Keep the actively-working indicator subtle so it doesn't compete for attention.
  if (state === 'running') {
    return <div className="status-dot running" />;
  }
  return null;
}

function stateClass(state: Session['state']): string {
  switch (state) {
    case 'waiting_permission': return 'waiting';
    case 'running': return 'running';
    case 'error': return 'error';
    default: return '';
  }
}

function SessionCard({ session, isSelected }: { session: Session; isSelected: boolean }) {
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);
  const setPanelMode = useUIStore((s) => s.setPanelMode);
  const deleteSession = useSessionStore((s) => s.deleteSession);
  const isUnread = useSessionStore((s) => s.unreadSessions.has(session.id));
  const { ref, touchHandlers } = useSwipeToDelete(() => deleteSession(session.id));

  const classes = [
    'session-card swipe-card',
    isSelected ? 'selected' : '',
    stateClass(session.state),
  ].filter(Boolean).join(' ');

  return (
    <div className="swipe-track">
      <div className="swipe-delete-backdrop"><span className="swipe-delete-text">Delete</span></div>
      <div ref={ref} className={classes} {...touchHandlers}
        onClick={() => { setActiveSession(session.id); setPanelMode('session'); setSidebarOpen(false); }}
      >
        <div className="session-card-info">
          <div className="session-card-name">{session.name}</div>
          <div className="session-card-path">{session.workspace_path} · {session.branch}</div>
        </div>
        <StatusDot state={session.state} isUnread={isUnread} />
      </div>
    </div>
  );
}

function RemoteSessionCard({ session, isSelected, machineConnected }: { session: RemoteSessionInfo; isSelected: boolean; machineConnected: boolean }) {
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);
  const setPanelMode = useUIStore((s) => s.setPanelMode);
  const requestSessionHistory = useSessionStore((s) => s.requestSessionHistory);
  const deleteRemoteSession = useSessionStore((s) => s.deleteRemoteSession);
  const hasOutput = useSessionStore((s) => (s.outputs[session.id]?.length ?? 0) > 0);
  const isUnread = useSessionStore((s) => s.unreadSessions.has(session.id));
  const showCommitBadge = useSessionStore((s) => s.config.show_commit_badge);
  const { ref, touchHandlers } = useSwipeToDelete(() => deleteRemoteSession(session.id));

  const isPending = session.id.startsWith('pending:');

  const handleClick = () => {
    if (isPending) return;
    setActiveSession(session.id);
    setPanelMode('session');
    setSidebarOpen(false);
    if (!hasOutput) {
      requestSessionHistory(session.id);
    }
  };

  if (isPending) {
    const pendingClasses = ['session-card', isSelected ? 'selected' : '', 'pending'].filter(Boolean).join(' ');
    return (
      <div className={pendingClasses} style={{ opacity: 0.7, cursor: 'default' }}>
        <div className="session-card-info">
          <div className="session-card-name">Starting...</div>
          <div className="session-card-path">
            <span className="session-card-path-text">Waiting for Claude Code...</span>
          </div>
        </div>
        <div className="status-dot running" />
      </div>
    );
  }

  const noTerminal = session.hasTerminal === false;
  const bridgeOffline = !machineConnected;
  const classes = ['session-card swipe-card', isSelected ? 'selected' : ''].filter(Boolean).join(' ');

  return (
    <div className="swipe-track">
      <div className="swipe-delete-backdrop"><span className="swipe-delete-text">Delete</span></div>
      <div ref={ref} className={classes} {...touchHandlers}
        onClick={handleClick} style={(noTerminal || bridgeOffline) ? { opacity: 0.5 } : undefined}
      >
        <div className="session-card-info">
          <div className="session-card-name">{session.title || session.slug}</div>
          <div className="session-card-path">
            <span className="session-card-path-text">{session.project}</span>
            {(noTerminal || bridgeOffline) && <span className="session-card-badge session-card-badge--offline">offline</span>}
            {showCommitBadge && session.committed && <span className="session-card-badge session-card-badge--committed">committed</span>}
            <span className="session-card-time">{relativeTime(session.lastActivity)}</span>
          </div>
        </div>
        <StatusDot state={session.state} isUnread={isUnread} />
      </div>
    </div>
  );
}

function NewDmInput({ onClose }: { onClose: () => void }) {
  const [pubkey, setPubkey] = useState('');
  const [error, setError] = useState('');
  const startConversation = useDmStore((s) => s.startConversation);
  const setPanelMode = useUIStore((s) => s.setPanelMode);
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);

  const handleSubmit = () => {
    const trimmed = pubkey.trim();
    if (!trimmed) return;

    const parsedHex = parsePublicKey(trimmed);
    if (!parsedHex) {
      setError('Invalid public key (npub or hex)');
      return;
    }

    startConversation(parsedHex);
    setPanelMode('dm');
    setSidebarOpen(false);
    setPubkey('');
    setError('');
    onClose();
  };

  return (
    <div className="new-dm-input">
      <input
        autoFocus
        className="new-dm-field"
        value={pubkey}
        onChange={(e) => { setPubkey(e.target.value); setError(''); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleSubmit();
          if (e.key === 'Escape') onClose();
        }}
        placeholder="npub or hex pubkey"
      />
      {error && <div className="new-dm-error">{error}</div>}
    </div>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
}

function DmDebugPanel() {
  const logEntries = useSyncExternalStore(debugSubscribe, getLogEntries);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logEntries]);

  const info = getDebugInfo();

  return (
    <div className="dm-debug-info">
      <div className="dm-debug-static">
        <div>pubkey: {info.pubkey ?? 'none'}</div>
        <div>filter: {JSON.stringify(info.filter)}</div>
        <div>events received: {info.eventsReceived}</div>
        <div>decrypt failures: {info.giftWrapFailures}</div>
        {Object.entries(info.relayStatus).map(([url, ok]) => (
          <div key={url} className={ok ? 'dm-debug-relay-ok' : 'dm-debug-relay-fail'}>
            {ok ? 'OK' : 'FAIL'} {url}
          </div>
        ))}
      </div>
      <hr className="dm-debug-divider" />
      <div className="dm-debug-log">
        {logEntries.length === 0 && <div className="dm-debug-empty">No log entries yet</div>}
        {logEntries.map((entry, i) => (
          <div key={i} className={`dm-debug-entry ${entry.level === 'warn' ? 'warn' : ''}`}>
            <span className="dm-debug-time">{formatTime(entry.timestamp)}</span>
            {' '}[{entry.tag}] {entry.message}
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="dm-debug-footer">
        <button className="dm-debug-clear" onClick={() => clearLog()}>Clear</button>
      </div>
    </div>
  );
}

export default function Sidebar() {
  const sessions = useSessionStore((s) => s.sessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setNewSessionOpen = useUIStore((s) => s.setNewSessionOpen);
  const panelMode = useUIStore((s) => s.panelMode);
  const conversations = useDmStore((s) => s.conversations);
  const activeConversationId = useDmStore((s) => s.activeConversationId);
  const connectionStatus = useDmStore((s) => s.connectionStatus);
  const machines = useSessionStore((s) => s.machines);
  const remoteSessions = useSessionStore((s) => s.remoteSessions);
  const refreshing = useSessionStore((s) => s.refreshing);
  const requestRefreshSessions = useSessionStore((s) => s.requestRefreshSessions);
  const [showNewDm, setShowNewDm] = useState(false);
  const [showDebugInfo, setShowDebugInfo] = useState(false);

  // --- Pull-to-refresh (ref-based to avoid per-frame re-renders) ---
  const listRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLDivElement>(null);
  const touchStartY = useRef(0);
  const pullRef = useRef(0);
  const isPullingRef = useRef(false);
  // Only used for the refreshing spinner (low-frequency state)
  const [triggered, setTriggered] = useState(false);

  const hasRemoteMachines = machines.length > 0;

  const updateIndicator = useCallback((distance: number) => {
    const el = indicatorRef.current;
    if (!el) return;
    if (distance > 0) {
      el.style.height = `${distance}px`;
      el.style.display = 'flex';
      const icon = el.querySelector('.pull-indicator-icon') as HTMLElement | null;
      const text = el.querySelector('.pull-indicator-text') as HTMLElement | null;
      if (icon) {
        icon.textContent = distance >= PULL_THRESHOLD ? '\u2191' : '\u2193';
        icon.className = `pull-indicator-icon${distance >= PULL_THRESHOLD ? ' ready' : ''}`;
      }
      if (text) {
        text.textContent = distance >= PULL_THRESHOLD ? 'Release to refresh' : 'Pull to refresh';
      }
    } else {
      el.style.height = '0px';
      el.style.display = 'none';
    }
  }, []);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if (!hasRemoteMachines) return;
    const el = listRef.current;
    // scrollTop <= 0 handles both 0 and negative values (iOS bounce)
    if (el && el.scrollTop <= 0) {
      touchStartY.current = e.touches[0].clientY;
      isPullingRef.current = true;
    }
  }, [hasRemoteMachines]);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (!isPullingRef.current) return;
    const el = listRef.current;
    if (!el || el.scrollTop > 0) {
      isPullingRef.current = false;
      pullRef.current = 0;
      updateIndicator(0);
      return;
    }
    const dy = Math.max(0, e.touches[0].clientY - touchStartY.current);
    const dampened = Math.min(MAX_PULL, Math.sqrt(dy) * 5);
    pullRef.current = dampened;
    updateIndicator(dampened);
  }, [updateIndicator]);

  const onTouchEnd = useCallback(() => {
    if (!isPullingRef.current) return;
    if (pullRef.current >= PULL_THRESHOLD && !refreshing) {
      requestRefreshSessions();
      setTriggered(true);
    }
    pullRef.current = 0;
    isPullingRef.current = false;
    updateIndicator(0);
  }, [refreshing, requestRefreshSessions, updateIndicator]);

  // Reset triggered state when refreshing completes
  useEffect(() => {
    if (triggered && !refreshing) {
      setTriggered(false);
    }
  }, [triggered, refreshing]);

  // Group local sessions
  const groups: Record<string, Session[]> = {};
  for (const session of sessions) {
    const group = session.group || 'DEFAULT';
    if (!groups[group]) groups[group] = [];
    groups[group].push(session);
  }

  const sortedConversations = [...conversations].sort(
    (a, b) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime(),
  );

  const hasLocalSessions = sessions.length > 0;

  return (
    <div className="sidebar">
      {/* Sessions header */}
      <div className="sidebar-header">
        <span className="sidebar-title">Sessions</span>
        <button className="sidebar-add-btn" onClick={() => setNewSessionOpen(true)}>+</button>
      </div>

      {/* Sessions list — fills remaining space above DMs */}
      <div
        className="sidebar-list"
        ref={listRef}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        {/* Pull-to-refresh indicator (height driven by ref, not state) */}
        {hasRemoteMachines && (
          <div
            ref={indicatorRef}
            className={`pull-indicator${refreshing ? ' spinning' : ''}`}
            style={{ height: refreshing ? 32 : 0, display: refreshing ? 'flex' : 'none' }}
          >
            <span className={`pull-indicator-icon${refreshing ? ' spinning' : ''}`}>
              {refreshing ? '...' : '\u2193'}
            </span>
            <span className="pull-indicator-text">{refreshing ? 'Refreshing...' : 'Pull to refresh'}</span>
          </div>
        )}
        {/* Remote machines */}
        {machines.map((machine) => {
          const machineSessions = [...(remoteSessions[machine.pubkeyHex] || [])].sort(
            (a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime(),
          );
          return (
            <div key={machine.pubkeyHex}>
              <div className="group-heading" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className={`dm-connection-dot ${machine.connected ? 'connected' : 'disconnected'}`} />
                <span style={{ flex: 1 }}>{machine.hostname}</span>
                {machine.connected && (
                  <button
                    className="sidebar-add-btn sidebar-add-btn-sm"
                    onClick={(e) => { e.stopPropagation(); setNewSessionOpen(true, machine); }}
                  >+</button>
                )}
              </div>
              {machineSessions.map((session) => (
                <RemoteSessionCard
                  key={session.id}
                  session={session}
                  isSelected={panelMode === 'session' && session.id === activeSessionId}
                  machineConnected={machine.connected}
                />
              ))}
              {machineSessions.length === 0 && (
                <div className="sidebar-empty" style={{ fontSize: 11, padding: '4px 16px' }}>
                  {machine.connected ? 'No sessions' : <span className="sidebar-connecting">Connecting<span className="connecting-dot dot-1">.</span><span className="connecting-dot dot-2">.</span><span className="connecting-dot dot-3">.</span></span>}
                </div>
              )}
            </div>
          );
        })}

        {/* Local sessions */}
        {hasRemoteMachines && hasLocalSessions && (
          <div className="group-heading" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="dm-connection-dot connected" />
            This device
          </div>
        )}
        {Object.entries(groups).map(([group, groupSessions]) => (
          <div key={group}>
            {!hasRemoteMachines && <div className="group-heading">{group}</div>}
            {hasRemoteMachines && group !== 'DEFAULT' && <div className="group-heading" style={{ paddingLeft: 24 }}>{group}</div>}
            {groupSessions.map((session) => (
              <SessionCard
                key={session.id}
                session={session}
                isSelected={panelMode === 'session' && session.id === activeSessionId}
              />
            ))}
          </div>
        ))}
        {!hasLocalSessions && !hasRemoteMachines && (
          <div className="sidebar-empty">
            <div style={{ marginBottom: 8 }}>No sessions yet</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              Connect to a VS Code machine to start coding remotely, or tap + to create a local session.
            </div>
          </div>
        )}
      </div>

      {/* DMs section — pinned to bottom, 2-tile height */}
      <div className={`dm-section${(panelMode === 'dm' || showNewDm) ? ' dm-section--active' : ''}`}>
        <div className="dm-section-header">
          <span className="dm-section-title">
            <span
              className={`dm-connection-dot ${connectionStatus}`}
              onClick={(e) => {
                e.stopPropagation();
                setShowDebugInfo(!showDebugInfo);
              }}
            />
            DMs
          </span>
          <button className="sidebar-add-btn dm-add-btn" onClick={() => setShowNewDm(!showNewDm)}>+</button>
        </div>

        {showNewDm && <NewDmInput onClose={() => setShowNewDm(false)} />}

        {showDebugInfo && <DmDebugPanel />}

        <div className="dm-section-list">
          {sortedConversations.map((conv) => (
            <DmTile
              key={conv.id}
              conversation={conv}
              isSelected={panelMode === 'dm' && conv.id === activeConversationId}
            />
          ))}
          {conversations.length === 0 && !showNewDm && (
            <div className="dm-section-empty">No conversations yet.</div>
          )}
        </div>
      </div>
    </div>
  );
}
