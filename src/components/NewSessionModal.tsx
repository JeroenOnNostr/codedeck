import { useState } from 'react';
import { useUIStore } from '../stores/uiStore';
import { useSessionStore } from '../stores/sessionStore';
import { MODELS, DEFAULT_MODEL } from '../constants/models';
import '../styles/modal.css';

export default function NewSessionModal() {
  const setNewSessionOpen = useUIStore((s) => s.setNewSessionOpen);
  const machine = useUIStore((s) => s.newSessionMachine);
  const createSession = useSessionStore((s) => s.createSession);
  const startOptimisticRemoteSession = useSessionStore((s) => s.startOptimisticRemoteSession);
  const sessions = useSessionStore((s) => s.sessions);
  const remoteSessions = useSessionStore((s) => s.remoteSessions);
  const defaultModel = useSessionStore((s) => s.config.model);
  const [name, setName] = useState('');
  const [group, setGroup] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [loading, setLoading] = useState(false);
  const [testSession, setTestSession] = useState(false);
  const [model, setModel] = useState<string>(defaultModel || DEFAULT_MODEL);
  // CDB-033. Empty = the workspace root, which is what every session used to get unconditionally.
  const [projectDir, setProjectDir] = useState('');

  const close = () => setNewSessionOpen(false);

  // --- Remote machine mode ---
  if (machine) {
    const machineSessions = remoteSessions[machine.pubkeyHex] || [];
    const projects = [...new Set(
      machineSessions
        .map((s) => s.project)
        .filter(Boolean)
        .filter(p => p !== 'Waiting for Claude Code...' && p !== 'Starting session…'),
    )];

    const handleRemoteCreate = () => {
      // Open a usable session view instantly; the real session reconciles in the
      // background and any first message typed now is flushed once it's ready.
      startOptimisticRemoteSession(machine, testSession, model, projectDir.trim() || undefined);
      close();
    };

    return (
      <div className="modal-overlay bottom-sheet" onClick={close}>
        <div className="modal-content bottom-sheet" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <span className="modal-title">New Session</span>
            <button className="modal-close" onClick={close}>&times;</button>
          </div>

          <label className="modal-label">Machine</label>
          <div className="modal-info">{machine.hostname}</div>

          {projects.length > 0 && (
            <>
              <label className="modal-label">Workspace</label>
              <div className="modal-info">{projects.join(', ')}</div>
            </>
          )}

          <label className="modal-label">Project folder</label>
          <input
            className="modal-input"
            value={projectDir}
            onChange={(e) => setProjectDir(e.target.value)}
            placeholder="workspace root"
            list="project-dirs"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          <datalist id="project-dirs">
            {projects.map((p) => <option key={p} value={p} />)}
          </datalist>
          <p className="modal-hint" style={{ marginBottom: 24 }}>
            Opens a new Claude Code terminal in the VSCode workspace. Leave the folder blank to use the
            workspace root, or name a subdirectory to root the session in one project — tools that read
            the session's directory, GSD above all, then see that project instead of the whole workspace.
            Session name is assigned automatically.
          </p>

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
