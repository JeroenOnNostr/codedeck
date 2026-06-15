import { useState, useEffect, useMemo, useCallback } from 'react';
import { useUIStore } from '../stores/uiStore';
import { useSessionStore } from '../stores/sessionStore';
import { useDmStore } from '../stores/dmStore';
import { useVoiceModeStore } from '../stores/voiceModeStore';
import { useQuickPromptStore } from '../stores/quickPromptStore';
import { AppConfig, AgentMode, EffortLevel, RemoteMachine } from '../types';
import { parsePrivateKey, getPubkeyHex, parsePublicKey } from '../services/nostrService';
import { api } from '../ipc/tauri';
import { sendSetCredentials } from '../services/bridgeService';
import { MODELS, DEFAULT_MODEL } from '../constants/models';
import * as nip19 from 'nostr-tools/nip19';
import { DEFAULT_BLOSSOM_SERVER } from '../utils/blossomUpload';
import '../styles/modal.css';

function ToggleRow({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="modal-toggle-row">
      <span style={{ fontSize: 14 }}>{label}</span>
      <button className={`toggle-switch ${value ? 'on' : 'off'}`} onClick={() => onChange(!value)}>
        <div className="toggle-knob" />
      </button>
    </div>
  );
}

export default function SettingsModal() {
  const config = useSessionStore((s) => s.config);
  const updateConfig = useSessionStore((s) => s.updateConfig);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const nostrConfig = useDmStore((s) => s.nostrConfig);
  const updateNostrConfig = useDmStore((s) => s.updateNostrConfig);
  const machines = useSessionStore((s) => s.machines);
  const addMachine = useSessionStore((s) => s.addMachine);
  const removeMachine = useSessionStore((s) => s.removeMachine);
  const initBridgeService = useSessionStore((s) => s.initBridgeService);

  const [local, setLocal] = useState<AppConfig>(config || {
    anthropic_api_key: null,
    github_pat: null,
    github_username: null,
    default_mode: 'plan' as AgentMode,
    default_effort: 'auto' as EffortLevel,
    auto_push_on_complete: true,
    notifications_enabled: true,
    workspace_base_path: '',
    max_sessions: 20,
    model: DEFAULT_MODEL,
    show_session_metadata: true,
    show_mode_badge: true,
    show_commit_badge: true,
    show_model_badge: true,
    show_usage_badge: true,
  });
  const [showApiKey, setShowApiKey] = useState(false);
  const [showPat, setShowPat] = useState(false);
  const [showNsec, setShowNsec] = useState(false);
  const [nostrKey, setNostrKey] = useState(nostrConfig.private_key_hex || '');
  const [relayList, setRelayList] = useState(nostrConfig.relays.join('\n'));
  const [blossomServer, setBlossomServer] = useState(nostrConfig.blossomServer || '');
  const [apiKeyStatus, setApiKeyStatus] = useState<'idle' | 'testing' | 'valid' | 'invalid'>('idle');
  const [apiKeyError, setApiKeyError] = useState('');
  const [newMachineNpub, setNewMachineNpub] = useState('');
  const [newMachineName, setNewMachineName] = useState('');
  const [machineError, setMachineError] = useState('');
  const [showDiscardWarning, setShowDiscardWarning] = useState(false);

  const isDirty = useMemo(() => {
    if (!config) return false;
    const configChanged = JSON.stringify(local) !== JSON.stringify(config);
    const nostrKeyChanged = nostrKey !== (nostrConfig.private_key_hex || '');
    const relayChanged = relayList !== nostrConfig.relays.join('\n');
    const blossomChanged = blossomServer !== (nostrConfig.blossomServer || '');
    const hasPendingMachine = newMachineNpub.trim().length > 0;
    return configChanged || nostrKeyChanged || relayChanged || blossomChanged || hasPendingMachine;
  }, [local, config, nostrKey, nostrConfig.private_key_hex, relayList, nostrConfig.relays, blossomServer, nostrConfig.blossomServer, newMachineNpub]);

  const handleClose = useCallback(() => {
    if (isDirty) {
      setShowDiscardWarning(true);
      return;
    }
    setSettingsOpen(false);
  }, [isDirty, setSettingsOpen]);

  const handleTestApiKey = async () => {
    const key = local.anthropic_api_key?.trim();
    if (!key) return;
    setApiKeyStatus('testing');
    setApiKeyError('');
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Timeout — check your connection')), 10000),
    );
    try {
      const result = await Promise.race([api.testApiKey(key), timeout]);
      if (result) {
        setApiKeyStatus('valid');
      } else {
        setApiKeyStatus('invalid');
        setApiKeyError('No response from API');
      }
    } catch (e: unknown) {
      setApiKeyStatus('invalid');
      setApiKeyError(String(e instanceof Error ? e.message : e) || 'Unknown error');
    }
  };

  useEffect(() => {
    if (config) setLocal(config);
  }, [config]);

  useEffect(() => {
    setRelayList(nostrConfig.relays.join('\n'));
  }, [nostrConfig.relays]);

  useEffect(() => {
    setNostrKey(nostrConfig.private_key_hex || '');
  }, [nostrConfig.private_key_hex]);

  useEffect(() => {
    setBlossomServer(nostrConfig.blossomServer || '');
  }, [nostrConfig.blossomServer]);

  const derivedNpub = useMemo(() => {
    if (!nostrKey) return '';
    const sk = parsePrivateKey(nostrKey);
    if (!sk) return '';
    const hex = getPubkeyHex(sk);
    return nip19.npubEncode(hex);
  }, [nostrKey]);

  const handleSave = async () => {
    await updateConfig(local);

    // Parse and save nostr config — store as hex internally
    const sk = nostrKey ? parsePrivateKey(nostrKey) : null;
    const privateKeyHex = sk
      ? Array.from(sk).map(b => b.toString(16).padStart(2, '0')).join('')
      : null;
    const relays = relayList
      .split('\n')
      .map(r => r.trim())
      .filter(r => r.startsWith('wss://') || r.startsWith('ws://'));
    const effectiveRelays = relays.length > 0 ? relays : ['wss://relay.primal.net', 'wss://nos.lol'];

    updateNostrConfig({
      private_key_hex: privateKeyHex,
      relays: effectiveRelays,
      blossomServer: blossomServer.trim() || undefined,
    });

    // Ensure bridge service is initialized before adding machines
    if (privateKeyHex) {
      initBridgeService(privateKeyHex);
    }

    // Auto-add pending machine if the npub field has a value
    if (newMachineNpub.trim()) {
      const pubkeyHex = parsePublicKey(newMachineNpub);
      if (pubkeyHex) {
        const machine: RemoteMachine = {
          hostname: newMachineName || 'Remote',
          npub: newMachineNpub.startsWith('npub1') ? newMachineNpub : nip19.npubEncode(pubkeyHex),
          pubkeyHex,
          relays: effectiveRelays,
          connected: false,
        };
        addMachine(machine);
      } else {
        setMachineError('Invalid npub — machine not added');
        return;
      }
    }

    setSettingsOpen(false);
  };

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Settings</span>
          <button className="modal-close" onClick={handleClose}>
            &times;
          </button>
        </div>

        {/* Authentication */}
        <div className="modal-section">
          <h3 className="modal-section-title">Authentication</h3>

          <label className="modal-label">Anthropic API Key</label>
          <div className="input-with-toggle" style={{ marginBottom: 4 }}>
            <input
              className="modal-input"
              type={showApiKey ? 'text' : 'password'}
              value={local.anthropic_api_key || ''}
              onChange={(e) => {
                setLocal({ ...local, anthropic_api_key: e.target.value || null });
                setApiKeyStatus('idle');
                setApiKeyError('');
              }}
              placeholder="sk-ant-api03-... or sk-ant-oat01-..."
            />
            <button className="show-hide-btn" onClick={() => setShowApiKey(!showApiKey)}>
              {showApiKey ? 'Hide' : 'Show'}
            </button>
            <button
              className="show-hide-btn"
              onClick={handleTestApiKey}
              disabled={apiKeyStatus === 'testing' || !local.anthropic_api_key}
              style={{ marginLeft: 4 }}
            >
              {apiKeyStatus === 'testing' ? '...' : 'Test'}
            </button>
          </div>
          <div style={{ fontSize: 11, padding: '0 0 12px', minHeight: 16 }}>
            {apiKeyStatus === 'testing' && (
              <span style={{ color: 'var(--text-muted)' }}>Testing API key...</span>
            )}
            {apiKeyStatus === 'valid' && (
              <span style={{ color: '#22c55e' }}>Valid</span>
            )}
            {apiKeyStatus === 'invalid' && (
              <span style={{ color: '#ef4444' }}>{apiKeyError || 'Invalid key'}</span>
            )}
            {apiKeyStatus === 'idle' && !local.anthropic_api_key && (
              <span style={{ color: 'var(--text-muted)' }}>Required for agent sessions</span>
            )}
          </div>

          <label className="modal-label">GitHub Personal Access Token</label>
          <div className="input-with-toggle" style={{ marginBottom: 16 }}>
            <input
              className="modal-input"
              type={showPat ? 'text' : 'password'}
              value={local.github_pat || ''}
              onChange={(e) => setLocal({ ...local, github_pat: e.target.value || null })}
              placeholder="ghp_..."
            />
            <button className="show-hide-btn" onClick={() => setShowPat(!showPat)}>
              {showPat ? 'Hide' : 'Show'}
            </button>
          </div>

          <label className="modal-label">GitHub Username</label>
          <input
            className="modal-input"
            value={local.github_username || ''}
            onChange={(e) => setLocal({ ...local, github_username: e.target.value || null })}
            placeholder="username"
          />
        </div>

        {/* Preferences */}
        <div className="modal-section">
          <h3 className="modal-section-title">Preferences</h3>

          <label className="modal-label">Default Mode</label>
          <select
            className="modal-input"
            value={local.default_mode}
            onChange={(e) => setLocal({ ...local, default_mode: e.target.value as AgentMode })}
            style={{ cursor: 'pointer' }}
          >
            <option value="plan">Plan</option>
            <option value="default">YOLO (default)</option>
            <option value="acceptEdits">Accept Edits</option>
          </select>

          <label className="modal-label">Default Effort</label>
          <select
            className="modal-input"
            value={local.default_effort ?? 'auto'}
            onChange={(e) => setLocal({ ...local, default_effort: e.target.value as EffortLevel })}
            style={{ cursor: 'pointer' }}
          >
            <option value="auto">Auto (model default)</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="xhigh">Extra High (Opus 4.7+ / Fable)</option>
            <option value="max">Max (new session only)</option>
          </select>

          <label className="modal-label">Model</label>
          <select
            className="modal-input"
            value={local.model}
            onChange={(e) => setLocal({ ...local, model: e.target.value })}
            style={{ cursor: 'pointer' }}
          >
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>

          <ToggleRow label="Auto-push on complete" value={local.auto_push_on_complete} onChange={v => setLocal({ ...local, auto_push_on_complete: v })} />
          <ToggleRow label="Notifications" value={local.notifications_enabled} onChange={v => setLocal({ ...local, notifications_enabled: v })} />
          <ToggleRow label="Show session metadata" value={local.show_session_metadata} onChange={v => setLocal({ ...local, show_session_metadata: v })} />
          <ToggleRow label="Show mode badge" value={local.show_mode_badge} onChange={v => setLocal({ ...local, show_mode_badge: v })} />
          <ToggleRow label="Show model badge" value={local.show_model_badge} onChange={v => setLocal({ ...local, show_model_badge: v })} />
          <ToggleRow label="Show usage badge" value={local.show_usage_badge} onChange={v => setLocal({ ...local, show_usage_badge: v })} />
          <ToggleRow label="Show commit badge" value={local.show_commit_badge} onChange={v => setLocal({ ...local, show_commit_badge: v })} />
        </div>

        {/* Quick Prompts */}
        <QuickPromptsSettings />

        {/* Voice Mode */}
        <VoiceModeSettings />

        {/* Nostr Identity */}
        <div className="modal-section">
          <h3 className="modal-section-title">Nostr Identity</h3>

          <label className="modal-label">Private Key (nsec or hex)</label>
          <div className="input-with-toggle" style={{ marginBottom: 16 }}>
            <input
              className="modal-input"
              type={showNsec ? 'text' : 'password'}
              value={nostrKey}
              onChange={(e) => setNostrKey(e.target.value)}
              placeholder="nsec1... or 64-char hex"
            />
            <button className="show-hide-btn" onClick={() => setShowNsec(!showNsec)}>
              {showNsec ? 'Hide' : 'Show'}
            </button>
          </div>

          {derivedNpub && (
            <>
              <label className="modal-label">Your Public Key</label>
              <input
                className="modal-input"
                value={derivedNpub}
                readOnly
                style={{ color: 'var(--text-secondary)', marginBottom: 16 }}
              />
            </>
          )}

          <label className="modal-label">DM Relays (one per line)</label>
          <textarea
            className="modal-input"
            value={relayList}
            onChange={(e) => setRelayList(e.target.value)}
            placeholder={'wss://relay.primal.net\nwss://nos.lol'}
            style={{ height: 80, resize: 'vertical', fontFamily: 'inherit' }}
          />

          <label className="modal-label">Blossom Media Server</label>
          <input
            className="modal-input"
            value={blossomServer}
            onChange={(e) => setBlossomServer(e.target.value)}
            placeholder={DEFAULT_BLOSSOM_SERVER}
          />
          <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '2px 0 0' }}>
            Encrypted image uploads for Claude Code sessions. Leave empty for default.
          </div>
        </div>

        {/* Remote Machines (Codedeck Bridge) */}
        <div className="modal-section">
          <h3 className="modal-section-title">Remote Machines</h3>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 12px' }}>
            Pair with machines running the Codedeck Bridge VSCode extension to control Claude Code remotely.
          </p>

          {machines.map((m) => (
            <div key={m.pubkeyHex} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-color)' }}>
              <div>
                <div style={{ fontSize: 14 }}>
                  <span className={`dm-connection-dot ${m.connected ? 'connected' : 'disconnected'}`} style={{ marginRight: 6 }} />
                  {m.hostname}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {m.authStatus?.hasAnthropicKey
                    ? (m.authStatus.hasEnvKey ? 'API key: env var' : 'API key: configured')
                    : 'No API key'}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="show-hide-btn"
                  onClick={async () => {
                    const key = local.anthropic_api_key?.trim();
                    if (!key) { alert('Enter an API key in the Authentication section first.'); return; }
                    await sendSetCredentials(m, key, local.github_pat?.trim() || null);
                  }}
                >
                  {m.authStatus?.hasAnthropicKey ? 'Update Key' : 'Send Key'}
                </button>
                <button
                  className="show-hide-btn"
                  onClick={() => removeMachine(m.pubkeyHex)}
                  style={{ color: '#ef4444' }}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}

          {machines.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '8px 0' }}>
              No machines paired yet.
            </div>
          )}

          <div style={{ marginTop: 12 }}>
            <label className="modal-label">Bridge npub</label>
            <input
              className="modal-input"
              value={newMachineNpub}
              onChange={(e) => { setNewMachineNpub(e.target.value); setMachineError(''); }}
              placeholder="npub1... (from Codedeck Bridge extension)"
            />
            <label className="modal-label">Machine name</label>
            <input
              className="modal-input"
              value={newMachineName}
              onChange={(e) => setNewMachineName(e.target.value)}
              placeholder="e.g., My Laptop"
            />
            {machineError && <div style={{ color: '#ef4444', fontSize: 11, padding: '4px 0' }}>{machineError}</div>}
            <button
              className="show-hide-btn"
              style={{ marginTop: 8 }}
              onClick={() => {
                const pubkeyHex = parsePublicKey(newMachineNpub);
                if (!pubkeyHex) {
                  setMachineError('Invalid npub');
                  return;
                }
                const relays = relayList
                  .split('\n')
                  .map(r => r.trim())
                  .filter(r => r.startsWith('wss://') || r.startsWith('ws://'));

                const machine: RemoteMachine = {
                  hostname: newMachineName || 'Remote',
                  npub: newMachineNpub.startsWith('npub1') ? newMachineNpub : nip19.npubEncode(pubkeyHex),
                  pubkeyHex,
                  relays: relays.length > 0 ? relays : ['wss://relay.primal.net', 'wss://nos.lol'],
                  connected: false,
                };
                addMachine(machine);
                setNewMachineNpub('');
                setNewMachineName('');
                setMachineError('');
              }}
            >
              + Add Machine
            </button>
          </div>
        </div>

        {/* Diagnostics */}
        <DiagnosticsSection />

        {showDiscardWarning && (
          <div className="modal-discard-bar">
            <span>You have unsaved changes</span>
            <div className="modal-discard-actions">
              <button className="modal-discard-btn" onClick={() => setSettingsOpen(false)}>Discard</button>
              <button className="modal-discard-btn modal-discard-cancel" onClick={() => setShowDiscardWarning(false)}>Cancel</button>
            </div>
          </div>
        )}

        <button className="modal-primary-btn" onClick={handleSave}>
          Save
        </button>
      </div>
    </div>
  );
}

function VoiceModeSettings() {
  const enabled = useVoiceModeStore((s) => s.enabled);
  const setEnabled = useVoiceModeStore((s) => s.setEnabled);
  const speechRate = useVoiceModeStore((s) => s.speechRate);
  const setSpeechRate = useVoiceModeStore((s) => s.setSpeechRate);
  const autoListen = useVoiceModeStore((s) => s.autoListenAfterRead);
  const setAutoListen = useVoiceModeStore((s) => s.setAutoListenAfterRead);

  return (
    <div className="modal-section">
      <h3 className="modal-section-title">Voice Mode</h3>

      <div className="modal-toggle-row">
        <span style={{ fontSize: 14 }}>Read actionable messages aloud</span>
        <button
          className={`toggle-switch ${enabled ? 'on' : 'off'}`}
          onClick={() => setEnabled(!enabled)}
        >
          <div className="toggle-knob" />
        </button>
      </div>

      <div className="modal-toggle-row">
        <span style={{ fontSize: 14 }}>Auto-listen after reading</span>
        <button
          className={`toggle-switch ${autoListen ? 'on' : 'off'}`}
          onClick={() => setAutoListen(!autoListen)}
        >
          <div className="toggle-knob" />
        </button>
      </div>

      <label style={{ display: 'block', fontSize: 14, color: 'var(--text-secondary)', marginTop: 8 }}>
        Speech rate: {speechRate.toFixed(1)}x
      </label>
      <input
        type="range"
        min={0.8}
        max={1.5}
        step={0.1}
        value={speechRate}
        onChange={(e) => setSpeechRate(parseFloat(e.target.value))}
        style={{ width: '100%', marginTop: 4 }}
      />
    </div>
  );
}

function QuickPromptsSettings() {
  const prompts = useQuickPromptStore((s) => s.prompts);
  const addPrompt = useQuickPromptStore((s) => s.addPrompt);
  const updatePrompt = useQuickPromptStore((s) => s.updatePrompt);
  const removePrompt = useQuickPromptStore((s) => s.removePrompt);

  const [newLabel, setNewLabel] = useState('');
  const [newPromptText, setNewPromptText] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editPromptText, setEditPromptText] = useState('');

  const handleAdd = () => {
    const label = newLabel.trim();
    const prompt = newPromptText.trim();
    if (!label || !prompt) return;
    addPrompt(label, prompt);
    setNewLabel('');
    setNewPromptText('');
  };

  const startEdit = (id: string, label: string, prompt: string) => {
    setEditingId(id);
    setEditLabel(label);
    setEditPromptText(prompt);
  };

  const saveEdit = () => {
    if (!editingId) return;
    const label = editLabel.trim();
    const prompt = editPromptText.trim();
    if (!label || !prompt) return;
    updatePrompt(editingId, label, prompt);
    setEditingId(null);
  };

  return (
    <div className="modal-section">
      <h3 className="modal-section-title">Quick Prompts</h3>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 12px' }}>
        Tap a quick prompt above the chat input to send it instantly.
      </p>

      {prompts.map((qp) =>
        editingId === qp.id ? (
          <div key={qp.id} style={{ marginBottom: 12, padding: 8, background: 'var(--bg-input)', borderRadius: 4 }}>
            <input
              className="modal-input"
              value={editLabel}
              onChange={(e) => setEditLabel(e.target.value)}
              placeholder="Label"
              style={{ marginBottom: 8 }}
            />
            <textarea
              className="modal-input"
              value={editPromptText}
              onChange={(e) => setEditPromptText(e.target.value)}
              placeholder="Prompt text"
              style={{ height: 64, resize: 'vertical', fontFamily: 'inherit', marginBottom: 8 }}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="show-hide-btn" onClick={saveEdit} style={{ height: 32 }}>Save</button>
              <button className="show-hide-btn" onClick={() => setEditingId(null)} style={{ height: 32 }}>Cancel</button>
            </div>
          </div>
        ) : (
          <div key={qp.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-color)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14 }}>{qp.label}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {qp.prompt}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
              <button className="show-hide-btn" onClick={() => startEdit(qp.id, qp.label, qp.prompt)} style={{ height: 32 }}>Edit</button>
              <button className="show-hide-btn" onClick={() => removePrompt(qp.id)} style={{ color: '#ef4444', height: 32 }}>Delete</button>
            </div>
          </div>
        )
      )}

      {prompts.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '8px 0' }}>
          No quick prompts yet.
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <label className="modal-label">Label</label>
        <input
          className="modal-input"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          placeholder='e.g. "Hindsight Refactor"'
        />
        <label className="modal-label">Prompt</label>
        <textarea
          className="modal-input"
          value={newPromptText}
          onChange={(e) => setNewPromptText(e.target.value)}
          placeholder="e.g. In hindsight, would you have built this differently?"
          style={{ height: 64, resize: 'vertical', fontFamily: 'inherit' }}
        />
        <button
          className="show-hide-btn"
          onClick={handleAdd}
          disabled={!newLabel.trim() || !newPromptText.trim()}
          style={{ marginTop: 4 }}
        >
          + Add Prompt
        </button>
      </div>
    </div>
  );
}

function DiagnosticsSection() {
  const [copied, setCopied] = useState(false);
  const errorLog = (window as unknown as Record<string, unknown>).__CODEDECK_ERROR_LOG as string[] | undefined;
  const dumpLog = (window as unknown as Record<string, unknown>).__CODEDECK_DUMP_LOG as (() => string) | undefined;
  const count = errorLog?.length ?? 0;

  const handleCopy = useCallback(async () => {
    if (!dumpLog) return;
    try {
      await navigator.clipboard.writeText(dumpLog());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may fail on some devices — fall back to prompt
      const text = dumpLog();
      prompt('Copy the error log below:', text);
    }
  }, [dumpLog]);

  return (
    <div className="modal-section">
      <h3 className="modal-section-title">Diagnostics</h3>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {count === 0 ? 'No errors captured' : `${count} log ${count === 1 ? 'entry' : 'entries'}`}
        </span>
        <button
          className="show-hide-btn"
          onClick={handleCopy}
          disabled={count === 0}
        >
          {copied ? 'Copied!' : 'Copy error log'}
        </button>
      </div>
    </div>
  );
}
