import { useState, useEffect, useRef } from 'react';
import { useUIStore } from '../stores/uiStore';
import { useSessionStore } from '../stores/sessionStore';
import { MODELS, DEFAULT_MODEL } from '../constants/models';
import '../styles/modal.css';

export default function NewSessionModal() {
  const setNewSessionOpen = useUIStore((s) => s.setNewSessionOpen);
  const machine = useUIStore((s) => s.newSessionMachine);
  const createSession = useSessionStore((s) => s.createSession);
  const createRemoteSession = useSessionStore((s) => s.createRemoteSession);
  const sessions = useSessionStore((s) => s.sessions);
  const remoteSessions = useSessionStore((s) => s.remoteSessions);
  const defaultModel = useSessionStore((s) => s.config.model);
  const [name, setName] = useState('');
  const [group, setGroup] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [testSession, setTestSession] = useState(false);
  const [model, setModel] = useState<string>(defaultModel || DEFAULT_MODEL);

  const close = () => setNewSessionOpen(false);

  // --- Remote machine mode ---
  if (machine) {
    const machineSessions = remoteSessions[machine.pubkeyHex] || [];
    const projects = [...new Set(machineSessions.map((s) => s.project).filter(Boolean).filter(p => p !== 'Waiting for Claude Code...'))];

    const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // Subscribe to store changes while loading — close when pending:* entry appears
    useEffect(() => {
      if (!loading) return;

      const unsub = useSessionStore.subscribe((state) => {
        const currentSessions = state.remoteSessions[machine.pubkeyHex] || [];
        // Close modal as soon as a pending:* entry appears (~1s)
        const hasPending = currentSessions.some(s => s.id.startsWith('pending:'));
        if (hasPending) {
          setLoading(false);
          close();
        }
      });

      // Elapsed time counter (updates every second)
      const startTime = Date.now();
      intervalRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startTime) / 1000));
      }, 1000);

      // 15s fallback timeout
      timeoutRef.current = setTimeout(() => {
        unsub();
        setLoading(false);
        close();
      }, 15000);

      return () => {
        unsub();
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        if (intervalRef.current) clearInterval(intervalRef.current);
      };
    }, [loading, machine.pubkeyHex, close]);

    const handleRemoteCreate = async () => {
      setElapsed(0);
      setLoading(true);
      await createRemoteSession(machine, testSession, model);
    };

    const handleCancel = () => {
      setLoading(false);
      close();
    };

    return (
      <div className="modal-overlay bottom-sheet" onClick={loading ? undefined : close}>
        <div className="modal-content bottom-sheet" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <span className="modal-title">New Session</span>
            {!loading && <button className="modal-close" onClick={close}>&times;</button>}
          </div>

          <label className="modal-label">Machine</label>
          <div className="modal-info">{machine.hostname}</div>

          {projects.length > 0 && (
            <>
              <label className="modal-label">Workspace</label>
              <div className="modal-info">{projects.join(', ')}</div>
            </>
          )}

          <p className="modal-hint" style={{ marginBottom: 24 }}>
            Opens a new Claude Code terminal in the VSCode workspace. Session name and project are assigned automatically.
          </p>

          {loading ? (
            <>
              <button className="modal-primary-btn" disabled>
                {elapsed >= 10 ? `Starting... (${elapsed}s)` : 'Starting...'}
              </button>
              {elapsed >= 15 && (
                <button
                  className="modal-secondary-btn"
                  onClick={handleCancel}
                  style={{ marginTop: 8 }}
                >
                  Cancel
                </button>
              )}
            </>
          ) : (
            <>
              <label className="modal-label">Model</label>
              <select
                className="modal-input"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                style={{ cursor: 'pointer', marginBottom: 16 }}
              >
                {MODELS.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 12, cursor: 'pointer' }}>
                <input type="checkbox" checked={testSession} onChange={(e) => setTestSession(e.target.checked)} />
                Device test session (enables on-device adb tools)
              </label>
              <button
                className="modal-primary-btn"
                onClick={handleRemoteCreate}
              >
                {testSession ? 'Start Test Session' : 'Start Session'}
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  // --- Local session mode ---
  const existingGroups = [...new Set(sessions.map((s) => s.group).filter(Boolean))];

  const handleCreate = async () => {
    if (!name.trim()) return;
    setLoading(true);
    await createSession(name.trim(), group.trim() || 'DEFAULT', repoUrl.trim(), branch.trim() || 'main');
    setLoading(false);
    close();
  };

  return (
    <div className="modal-overlay bottom-sheet" onClick={close}>
      <div className="modal-content bottom-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">New Session</span>
          <button className="modal-close" onClick={close}>&times;</button>
        </div>

        <label className="modal-label">Name</label>
        <input
          className="modal-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Session name"
          autoFocus
        />

        <label className="modal-label">Group</label>
        <input
          className="modal-input"
          value={group}
          onChange={(e) => setGroup(e.target.value)}
          placeholder="e.g., WORK, PERSONAL"
          list="groups"
        />
        <datalist id="groups">
          {existingGroups.map((g) => <option key={g} value={g} />)}
        </datalist>

        <label className="modal-label">Repository</label>
        <input
          className="modal-input"
          value={repoUrl}
          onChange={(e) => setRepoUrl(e.target.value)}
          placeholder="https://github.com/user/repo"
        />

        <label className="modal-label">Branch</label>
        <input
          className="modal-input"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          placeholder="main"
          style={{ marginBottom: 24 }}
        />

        <button
          className="modal-primary-btn"
          onClick={handleCreate}
          disabled={!name.trim() || loading}
        >
          {loading ? 'Cloning...' : 'Clone & Start'}
        </button>
      </div>
    </div>
  );
}
