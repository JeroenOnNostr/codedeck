import { useState } from 'react';
import { useUIStore } from '../stores/uiStore';
import { useSessionStore } from '../stores/sessionStore';
import { MODELS, DEFAULT_MODEL } from '../constants/models';
import '../styles/modal.css';
import '../styles/gsd.css';

/** Folder name → a path the bridge will accept: no separators, no traversal, no leading dots. */
export function sanitizeProjectFolder(raw: string): string {
  return raw
    .trim()
    .replace(/[/\\]+/g, '-')     // a name, not a path — the bridge confines cwd to the workspace anyway
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .replace(/^[.-]+/, '')       // no dotfiles, no leading dash
    .slice(0, 64);
}

export default function NewSessionModal() {
  const setNewSessionOpen = useUIStore((s) => s.setNewSessionOpen);
  const machine = useUIStore((s) => s.newSessionMachine);
  const openedForGsd = useUIStore((s) => s.newSessionGsd);
  const createSession = useSessionStore((s) => s.createSession);
  const startOptimisticRemoteSession = useSessionStore((s) => s.startOptimisticRemoteSession);
  const sessions = useSessionStore((s) => s.sessions);
  const remoteSessions = useSessionStore((s) => s.remoteSessions);
  const defaultModel = useSessionStore((s) => s.config.model);
  const machineProtocolVersion = useSessionStore((s) => s.machineProtocolVersion);
  const remoteSessionGsd = useSessionStore((s) => s.remoteSessionGsd);
  const [name, setName] = useState('');
  const [group, setGroup] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [loading, setLoading] = useState(false);
  const [testSession, setTestSession] = useState(false);
  const [model, setModel] = useState<string>(defaultModel || DEFAULT_MODEL);
  // CDB-033. Empty = the workspace root, which is what every session used to get unconditionally.
  const [projectDir, setProjectDir] = useState('');
  // When the folder doesn't exist yet, the bridge creates and `git init`s it — that is what makes
  // "start a new GSD project from the phone" possible rather than only opening existing ones.
  const [createDir, setCreateDir] = useState(false);
  // CD-058. The whole point of the GSD strip was to be able to start a project from the phone, but
  // the only route was: guess that "Project folder" is the GSD entry point, tick a checkbox whose
  // label never says GSD, then find "Enable GSD for this session" in an overflow menu. This is that
  // route, named.
  const [gsdProject, setGsdProject] = useState(openedForGsd);
  const [gsdName, setGsdName] = useState('');
  // GSD's workflows run a lot of tools (its own CLI, git, mkdir, sub-agents). Approving each one
  // from a phone is the difference between a workflow and a chore, so hands-free is the default —
  // it is a brand-new, empty project folder, and the header switches modes in one tap.
  const [gsdHandsFree, setGsdHandsFree] = useState(true);

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

    // CDB-033 landed in bridge protocol v8. Older bridges drop `cwd` without a word.
    const supportsProjectDir = (machineProtocolVersion[machine.pubkeyHex] ?? 0) >= 8;

    // Don't offer a GSD flow on a laptop that has no GSD — the session would open fine and then
    // `/gsd-new-project` would come back as an unknown command. Only hide it on an actual "no":
    // before any session on this machine has been polled we know nothing, and hiding the feature
    // on no evidence is the worse error.
    const machineGsd = machineSessions
      .map((s) => remoteSessionGsd[s.id])
      .filter((g): g is NonNullable<typeof g> => !!g);
    const gsdKnownMissing = machineGsd.length > 0 && machineGsd.every((g) => !g.installed);
    const canOfferGsd = supportsProjectDir && !gsdKnownMissing;
    const gsdMode = gsdProject && canOfferGsd;

    const gsdFolder = sanitizeProjectFolder(gsdName);

    const handleRemoteCreate = () => {
      // Open a usable session view instantly; the real session reconciles in the
      // background and any first message typed now is flushed once it's ready.
      if (gsdMode) {
        if (!gsdFolder) return;
        startOptimisticRemoteSession(machine, {
          model,
          cwd: gsdFolder,
          createCwd: true,
          // The command GSD itself recommends for "no project yet" (`smart-entry` → new-project),
          // in the flat command form this machine installs.
          gsd: { command: '/gsd-new-project', mode: gsdHandsFree ? 'default' : 'acceptEdits' },
        });
        close();
        return;
      }
      const dir = projectDir.trim();
      startOptimisticRemoteSession(machine, {
        testSession,
        model,
        cwd: dir || undefined,
        createCwd: dir ? createDir : false,
      });
      close();
    };

    // Only meaningful once a folder is named, and only offered if the bridge can honour it.
    const isNewProject = supportsProjectDir && projectDir.trim().length > 0;

    return (
      <div className="modal-overlay bottom-sheet" onClick={close}>
        <div className="modal-content bottom-sheet" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <span className="modal-title">New Session</span>
            <button className="modal-close" onClick={close}>&times;</button>
          </div>

          <label className="modal-label">Machine</label>
          <div className="modal-info">{machine.hostname}</div>

          {/* Rooting a session in its own folder is what makes GSD possible at all, so this needs
              the same v8 bridge as the Project folder field below. */}
          {canOfferGsd && (
            <div className="gsd-new-toggle">
              <label className="gsd-new-toggle-row">
                <input
                  type="checkbox"
                  checked={gsdProject}
                  onChange={(e) => setGsdProject(e.target.checked)}
                />
                <span className="gsd-new-toggle-label">Start a new GSD project</span>
              </label>
              <p className="modal-hint gsd-new-toggle-hint">
                Guided plan-driven workflow: GSD interviews you, writes a roadmap, then plans and
                executes it phase by phase — and the stage strip drives it from here.
              </p>
            </div>
          )}

          {gsdMode ? (
            <>
              <label className="modal-label">Project name</label>
              <input
                className="modal-input"
                value={gsdName}
                onChange={(e) => setGsdName(e.target.value)}
                placeholder="my-new-app"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoFocus
              />
              <p className="modal-hint" style={{ marginBottom: 12 }}>
                {gsdFolder
                  ? `Roots the session in “${gsdFolder}” in the workspace — created and git-initialised if it doesn't exist yet — then runs /gsd-new-project there.`
                  : "The session gets its own folder in the workspace, created and git-initialised if new. GSD needs a repo, and giving it one of its own is what keeps it away from the other projects."}
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

              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={gsdHandsFree} onChange={(e) => setGsdHandsFree(e.target.checked)} />
                Run hands-free (auto-approve tools)
              </label>
              <p className="modal-hint" style={{ marginBottom: 20 }}>
                {gsdHandsFree
                  ? 'GSD runs its own CLI, git and sub-agents constantly — approving each one from a phone would stall the interview. You still answer every question it asks. Change the mode in the session header any time.'
                  : 'File edits are auto-approved, but every command asks first. Expect a lot of approval cards during the interview.'}
              </p>

              <button
                className="modal-primary-btn"
                onClick={handleRemoteCreate}
                disabled={!gsdFolder}
              >
                Start GSD Project
              </button>
            </>
          ) : (
            <>
              {projects.length > 0 && (
                <>
                  <label className="modal-label">Workspace</label>
                  <div className="modal-info">{projects.join(', ')}</div>
                </>
              )}

              {/* A pre-v8 bridge ignores `cwd` silently, so offering the field there would be a lie —
                  the session would open at the workspace root with nothing saying so (CDB-033). */}
              {supportsProjectDir && (
                <>
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
                  {isNewProject && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginTop: 8, cursor: 'pointer' }}>
                      <input type="checkbox" checked={createDir} onChange={(e) => setCreateDir(e.target.checked)} />
                      Create it if it doesn't exist (new git repo)
                    </label>
                  )}
                </>
              )}
              <p className="modal-hint" style={{ marginBottom: 24 }}>
                {supportsProjectDir
                  ? `Opens a new Claude Code terminal in the VSCode workspace. Leave the folder blank to use the workspace root, or name a subdirectory to root the session in one project — tools that read the session's directory, GSD above all, then see that project instead of the whole workspace. Session name is assigned automatically.`
                  : `Opens a new Claude Code terminal in the VSCode workspace. Session name and project are assigned automatically. Update the bridge to choose a project folder for the session.`}
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
