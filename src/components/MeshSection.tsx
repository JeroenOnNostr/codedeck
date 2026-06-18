import { useState, useEffect, useCallback } from 'react';
import { invoke, isTauri } from '../ipc/tauri';
import { useSessionStore } from '../stores/sessionStore';
import { sendSetDeviceConfig } from '../services/bridgeService';
import { persistGet } from '../services/persistStore';
import { TEST_TARGET_KEY, setTestTarget as persistTestTarget } from '../services/meshClient';
import type { DeviceConfig } from '../types';

/**
 * Mesh (nostr-vpn) settings section.
 *
 * Lets the phone join the encrypted FIPS mesh so the office laptop can reach this device over the
 * overlay (for remote on-device testing). The heavy lifting is in `tauri-plugin-mesh`'s Android
 * VpnService; this is the control surface. On desktop / browser-mock the plugin returns null, so
 * the section shows a "mobile only" note instead of dead buttons.
 *
 * Plugin commands (see codedeck/tauri-plugin-mesh):
 *   plugin:mesh|mesh_status  -> { running, state_json }
 *   plugin:mesh|join_mesh    -> { running, state_json }   (triggers VPN consent on first use)
 *   plugin:mesh|leave_mesh   -> { running, state_json }
 *   plugin:mesh|mesh_action  -> { state_json }             (generic engine action passthrough)
 */

interface MeshStatus {
  running: boolean;
  state_json: string;
}

// A minimal view of the engine's NativeAppState JSON we care about here. The engine emits much more;
// we only read what the section displays so we don't couple to the full schema.
// NOTE: there is NO top-level `activeNetwork` object — nvpn's own UI derives it as
// `networks.firstOrNull { it.enabled }` (Models.kt). We mirror that exactly. The local mesh address
// is the top-level `tunnelIp`, not a per-network field.
interface MeshNetwork {
  id?: string;
  name?: string;
  enabled?: boolean;
  networkId?: string;
}
interface MeshState {
  vpnEnabled?: boolean;
  vpnActive?: boolean;
  tunnelIp?: string;
  networkId?: string;
  networks?: MeshNetwork[];
  error?: string;
}

function parseState(json: string): MeshState {
  if (!json) return {};
  try {
    return JSON.parse(json) as MeshState;
  } catch {
    return {};
  }
}

/** The active network = first enabled network, mirroring nvpn's `AppState.activeNetwork`. */
function activeNetwork(s: MeshState): MeshNetwork | undefined {
  return s.networks?.find((n) => n.enabled) ?? s.networks?.[0];
}

export default function MeshSection() {
  const onMobile = isTauri();
  const [status, setStatus] = useState<MeshStatus | null>(null);
  const [state, setState] = useState<MeshState>({});
  const [invite, setInvite] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [supported, setSupported] = useState<boolean | null>(null);
  // Per-device opt-in: only when ON does CodeDeck auto-enable Wireless Debugging (expose adb over the
  // mesh). Off by default so a controller phone never opens an adb listener just by joining the mesh.
  const [testTarget, setTestTarget] = useState(false);
  const [wdActive, setWdActive] = useState(false);

  const refresh = useCallback(async () => {
    const s = await invoke<MeshStatus>('plugin:mesh|mesh_status');
    // null => plugin unavailable (desktop/mock) OR no Android impl on this platform.
    setSupported(s !== null);
    if (s) {
      setStatus(s);
      setState(parseState(s.state_json));
    }
  }, []);

  // Load the persisted test-target opt-in once.
  useEffect(() => {
    persistGet<boolean>(TEST_TARGET_KEY).then((v) => setTestTarget(!!v)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!onMobile) { setSupported(false); return; }
    // Poll a few times after mount: the first mesh_status triggers a one-time async engine init on
    // the native side, so a persisted network (imported invite) only appears on a later poll.
    // Stops early once a network shows up.
    let cancelled = false;
    let tries = 0;
    const tick = async () => {
      if (cancelled) return;
      await refresh();
      tries += 1;
      if (!cancelled && tries < 6) {
        // re-read current state; if a network is now present we can stop polling
        const s = await invoke<MeshStatus>('plugin:mesh|mesh_status');
        const joined = s ? !!activeNetwork(parseState(s.state_json)) : false;
        if (!joined) setTimeout(tick, 700);
      }
    };
    tick();
    return () => { cancelled = true; };
  }, [onMobile, refresh]);

  const importInvite = useCallback(async () => {
    const code = invite.trim();
    if (!code) { setError('Paste a mesh invite first.'); return; }
    setBusy(true); setError('');
    try {
      const res = await invoke<{ state_json: string }>('plugin:mesh|mesh_action', {
        actionJson: JSON.stringify({ type: 'import_network_invite', invite: code }),
      });
      if (res) {
        const st = parseState(res.state_json);
        setState(st);
        if (st.error) setError(st.error);
        else setInvite('');
      }
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [invite, refresh]);

  const toggleMesh = useCallback(async () => {
    setBusy(true); setError('');
    try {
      const cmd = status?.running ? 'plugin:mesh|leave_mesh' : 'plugin:mesh|join_mesh';
      const res = await invoke<MeshStatus>(cmd);
      if (res) {
        setStatus(res);
        const st = parseState(res.state_json);
        setState(st);
        if (st.error) setError(st.error);
        // On a fresh connect, IF this device is a designated test target, prepare adb-over-mesh so
        // the laptop can reach it without a USB cable or a manual Wireless-Debugging toggle. Gated
        // by the per-device opt-in: a controller phone never auto-opens an adb listener.
        if (res.running && testTarget) {
          invoke<{ enabled: boolean }>('plugin:mesh|prepare_adb')
            .then((r) => setWdActive(!!r?.enabled))
            .catch(() => {});
        }
      }
    } catch (e) {
      // join_mesh rejects if the user denies the VPN consent dialog.
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [status]);

  // While the mesh is up AND this device is a designated test target, keep Wireless Debugging alive
  // (it silently turns off on idle / network change). A light heartbeat re-enables it so the laptop's
  // adb connection self-heals without any interaction on the phone. NEVER runs on a controller — a
  // device only exposes adb when the user explicitly opts it in as a test target.
  useEffect(() => {
    if (!onMobile || !status?.running || !testTarget) { setWdActive(false); return; }
    let cancelled = false;
    const beat = () => invoke<{ enabled: boolean }>('plugin:mesh|prepare_adb')
      .then((r) => { if (!cancelled) setWdActive(!!r?.enabled); })
      .catch(() => {});
    beat();
    const id = setInterval(beat, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [onMobile, status?.running, testTarget]);

  return (
    <div className="modal-section">
      <h3 className="modal-section-title">Mesh (remote testing)</h3>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 12px' }}>
        Join the encrypted mesh so your office laptop can install &amp; drive dev builds on this phone
        from anywhere. The easiest way is to scan the Pair QR from the laptop — it joins the mesh for
        you. The controls below are for checking status or joining manually.
      </p>

      {supported === false && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '8px 0' }}>
          Mesh is available on the Android app only (it runs as a system VPN service).
        </div>
      )}

      {supported && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border-color)' }}>
            <div>
              <div style={{ fontSize: 14 }}>
                <span className={`dm-connection-dot ${status?.running ? 'connected' : 'disconnected'}`} style={{ marginRight: 6 }} />
                {status?.running ? 'Connected' : 'Disconnected'}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {(() => {
                  const net = activeNetwork(state);
                  return net
                    ? `Network: ${net.name || net.networkId || 'mesh'}${state.tunnelIp ? ` · ${state.tunnelIp}` : ''}`
                    : 'No network joined yet';
                })()}
              </div>
            </div>
            <button className="show-hide-btn" onClick={toggleMesh} disabled={busy || !activeNetwork(state)}>
              {status?.running ? 'Disconnect' : 'Connect'}
            </button>
          </div>

          {/* Per-device opt-in: only a designated TEST TARGET exposes adb over the mesh. */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid var(--border-color)' }}>
            <div>
              <div style={{ fontSize: 13 }}>Use this device as a test target</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                Lets the laptop install &amp; drive dev builds here over adb. Enables Wireless Debugging
                while connected. Leave OFF on your controller phone.
              </div>
              {wdActive && (
                <div style={{ fontSize: 11, color: '#f59e0b', marginTop: 4 }}>
                  ● Wireless Debugging is ON for remote testing
                </div>
              )}
            </div>
            <input
              type="checkbox"
              checked={testTarget}
              onChange={(e) => {
                const v = e.target.checked;
                setTestTarget(v);
                persistTestTarget(v).catch(() => {});
                if (v && status?.running) {
                  invoke<{ enabled: boolean }>('plugin:mesh|prepare_adb').then((r) => setWdActive(!!r?.enabled)).catch(() => {});
                } else if (!v) {
                  setWdActive(false);
                }
              }}
              style={{ width: 20, height: 20, flexShrink: 0, marginLeft: 12 }}
            />
          </div>

          <div style={{ marginTop: 12 }}>
            <label className="modal-label">Mesh invite (manual fallback)</label>
            <input
              className="modal-input"
              value={invite}
              onChange={(e) => { setInvite(e.target.value); setError(''); }}
              placeholder="nvpn://invite..."
            />
            <button className="show-hide-btn" style={{ marginTop: 8 }} onClick={importInvite} disabled={busy}>
              {busy ? 'Working…' : 'Import invite'}
            </button>
          </div>

          {error && (
            <div style={{ fontSize: 12, color: '#ef4444', marginTop: 8 }}>{error}</div>
          )}
        </>
      )}

      <DeviceConfigBlock />
    </div>
  );
}

/**
 * Test-device config: tell the office laptop which device to target over the mesh and which app
 * to build/install for autonomous testing. Sent to every paired bridge via set-device-config.
 */
function DeviceConfigBlock() {
  const machines = useSessionStore((s) => s.machines);
  const [label, setLabel] = useState('Pixel 9');
  const [serial, setSerial] = useState('');
  const [app, setApp] = useState<DeviceConfig['appUnderTest']>('kubo');
  const [customPackage, setCustomPackage] = useState('');
  const [customBuildCmd, setCustomBuildCmd] = useState('');
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');

  const save = useCallback(async () => {
    setErr(''); setSaved(false);
    const s = serial.trim();
    if (!s) { setErr('Enter the test device serial (mesh IP:port, e.g. 10.44.x.y:5555).'); return; }
    const config: DeviceConfig = {
      label: label.trim() || 'Test device',
      serial: s,
      appUnderTest: app,
      ...(app === 'custom' ? { customPackage: customPackage.trim(), customBuildCmd: customBuildCmd.trim() } : {}),
    };
    const targets = machines.length ? machines : [];
    if (!targets.length) { setErr('Pair a bridge (Remote Machines) first.'); return; }
    try {
      await Promise.all(targets.map((m) => sendSetDeviceConfig(m, config)));
      setSaved(true);
    } catch (e) {
      setErr(String(e));
    }
  }, [label, serial, app, customPackage, customBuildCmd, machines]);

  return (
    <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border-color)' }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Test device</div>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 12px' }}>
        Which device the agent installs &amp; drives, and which app it builds. The serial is the
        device's mesh IP:port (after it joins the mesh above).
      </p>
      <label className="modal-label">Label</label>
      <input className="modal-input" value={label} onChange={(e) => { setLabel(e.target.value); setSaved(false); }} placeholder="e.g. Pixel 9" />
      <label className="modal-label">Device serial (mesh IP:port)</label>
      <input className="modal-input" value={serial} onChange={(e) => { setSerial(e.target.value); setSaved(false); }} placeholder="10.44.12.34:5555" />
      {isTauri() && (
        <button
          className="show-hide-btn"
          style={{ marginTop: 6 }}
          onClick={() => { invoke('plugin:mesh|open_wireless_debugging').catch(() => {}); }}
          title="Open Android Wireless Debugging settings to enable adb + read the IP:port"
        >
          Enable Wireless Debugging…
        </button>
      )}
      <label className="modal-label">App under test</label>
      <select className="modal-input" value={app} onChange={(e) => { setApp(e.target.value as DeviceConfig['appUnderTest']); setSaved(false); }}>
        <option value="kubo">Kubo</option>
        <option value="veil">Veil</option>
        <option value="custom">Custom</option>
      </select>
      {app === 'custom' && (
        <>
          <label className="modal-label">Package id</label>
          <input className="modal-input" value={customPackage} onChange={(e) => { setCustomPackage(e.target.value); setSaved(false); }} placeholder="com.example.dev" />
          <label className="modal-label">Build command</label>
          <input className="modal-input" value={customBuildCmd} onChange={(e) => { setCustomBuildCmd(e.target.value); setSaved(false); }} placeholder="npm run build:apk" />
        </>
      )}
      <button className="show-hide-btn" style={{ marginTop: 8 }} onClick={save}>
        {saved ? 'Saved ✓' : 'Save device config'}
      </button>
      {err && <div style={{ fontSize: 12, color: '#ef4444', marginTop: 8 }}>{err}</div>}
    </div>
  );
}
