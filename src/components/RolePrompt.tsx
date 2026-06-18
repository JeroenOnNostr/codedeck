import { useState } from 'react';
import { useUIStore } from '../stores/uiStore';
import { sendSetDeviceConfig } from '../services/bridgeService';
import { connectMesh, setTestTarget, getMeshIdentity } from '../services/meshClient';
import type { DeviceConfig } from '../types';

/**
 * One-time role prompt, shown after a one-QR pairing that bundled a mesh invite (see App.tsx).
 * The ONLY decision the user makes during setup: is this phone my controller, or a test device?
 *
 *  - Controller  → nothing more to do; it talks to the bridge over relays. (Not added to the mesh,
 *                  so a shoulder-surfed QR used as a controller grants no mesh access.)
 *  - Test device → connect to the mesh, flag this device as a test target (so Wireless Debugging is
 *                  kept alive), and tell the bridge `role: 'test-target'` with NO serial — the bridge
 *                  derives the device's mesh IP from its pubkey. Zero typing.
 */
export default function RolePrompt() {
  const prompt = useUIStore((s) => s.rolePrompt);
  const setRolePrompt = useUIStore((s) => s.setRolePrompt);
  const [busy, setBusy] = useState<null | 'controller' | 'test-target'>(null);

  if (!prompt) return null;

  const close = () => setRolePrompt(null);

  const chooseController = () => {
    // A controller needs no mesh membership; it reaches the bridge over relays. Done.
    close();
  };

  const chooseTestDevice = async () => {
    setBusy('test-target');
    try {
      // 1. Opt this device in as a test target (MeshSection's heartbeat then keeps WD alive).
      await setTestTarget(true);
      // 2. Connect to the mesh (fires the Android VPN consent dialog on first use).
      await connectMesh();
      // 3. Read our REAL mesh identity (IP + mesh pubkey). The mesh engine has its own key, so the
      //    bridge can't derive this — we are the source of truth. The engine may take a moment to
      //    assign the tunnel IP after connect, so poll briefly.
      let mesh = await getMeshIdentity();
      for (let i = 0; i < 5 && !mesh; i++) {
        await new Promise((r) => setTimeout(r, 600));
        mesh = await getMeshIdentity();
      }
      // 4. Tell every paired bridge this is a test target, reporting our real mesh IP + pubkey so the
      //    bridge can adb-reach us and authorize the right identity on the roster. No typing.
      const config: DeviceConfig = {
        label: prompt.machine.hostname ? `${prompt.machine.hostname} test device` : 'Test device',
        role: 'test-target',
        appUnderTest: 'kubo',
        ...(mesh ? { meshIp: mesh.meshIp, meshPubkey: mesh.meshPubkey } : {}),
      };
      await sendSetDeviceConfig(prompt.machine, config).catch(() => {});
    } finally {
      setBusy(null);
      close();
    }
  };

  return (
    <div className="modal-overlay bottom-sheet" onClick={busy ? undefined : close}>
      <div className="modal-content bottom-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Set up this phone</span>
          {!busy && <button className="modal-close" onClick={close}>&times;</button>}
        </div>

        <p className="modal-hint" style={{ marginBottom: 20 }}>
          Paired with <strong>{prompt.machine.hostname}</strong>
          {prompt.meshImported ? ' and joined its mesh.' : '.'} What is this phone for?
        </p>

        <button
          className="modal-primary-btn"
          disabled={!!busy}
          onClick={chooseController}
          style={{ marginBottom: 12, textAlign: 'left', height: 'auto', padding: '14px 16px' }}
        >
          <div style={{ fontWeight: 600 }}>This is my controller</div>
          <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>
            I'll drive Claude Code from this phone. (Most people pick this.)
          </div>
        </button>

        <button
          className="modal-secondary-btn"
          disabled={!!busy}
          onClick={chooseTestDevice}
          style={{ textAlign: 'left', height: 'auto', padding: '14px 16px' }}
        >
          <div style={{ fontWeight: 600 }}>{busy === 'test-target' ? 'Setting up…' : 'This is a test device'}</div>
          <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>
            The laptop installs &amp; drives dev builds here. Turns on Wireless Debugging over the mesh.
          </div>
        </button>
      </div>
    </div>
  );
}
