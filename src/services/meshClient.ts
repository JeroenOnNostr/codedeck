/**
 * Mesh client helpers — the phone side of one-QR setup, shared between the deep-link handler
 * (App.tsx) and the Mesh settings section (MeshSection.tsx) so there's a single source of truth for
 * importing an invite, connecting, and the test-target opt-in.
 *
 * All calls go through the `tauri-plugin-mesh` Android VpnService and are no-ops (return false/null)
 * on desktop/browser-mock where the plugin is unavailable.
 */

import { invoke, isTauri } from '../ipc/tauri';
import { persistSet } from './persistStore';

/** Persist key for the per-device opt-in that lets CodeDeck auto-enable Wireless Debugging (adb over
 *  the mesh). OFF by default: only a device the user designates as a TEST TARGET should expose adb.
 *  Shared with MeshSection so the role prompt and the manual toggle stay in sync. */
export const TEST_TARGET_KEY = 'mesh.testTarget';

/**
 * Import an `nvpn://invite/...` code into the engine (idempotent on the native side). Returns true on
 * success. Safe to call when already a member — the engine merges/no-ops.
 */
export async function importMeshInvite(invite: string): Promise<boolean> {
  if (!isTauri()) return false;
  const code = invite.trim();
  if (!code) return false;
  try {
    const res = await invoke<{ state_json: string }>('plugin:mesh|mesh_action', {
      actionJson: JSON.stringify({ type: 'import_network_invite', invite: code }),
    });
    return res !== null;
  } catch {
    return false;
  }
}

export interface MeshIdentity {
  /** The phone's real mesh tunnel IP, e.g. "10.44.126.167" (no /32). */
  meshIp: string;
  /** The phone's mesh-engine pubkey (hex) — the identity to authorize on the roster. */
  meshPubkey: string;
}

/**
 * Read the phone's OWN mesh identity (tunnel IP + mesh pubkey) from the engine state. The mesh
 * VpnService runs its own nostr key, separate from the app/bridge key, so this is the only
 * authoritative source for the device's adb-reachable mesh IP. Returns null if unavailable or the
 * engine hasn't assigned a tunnel IP yet. `tunnelIp`/`ownPubkeyHex` are top-level camelCase fields
 * of the engine's UiState (state.rs).
 */
export async function getMeshIdentity(): Promise<MeshIdentity | null> {
  if (!isTauri()) return null;
  try {
    const s = await invoke<{ state_json: string }>('plugin:mesh|mesh_status');
    if (!s?.state_json) return null;
    const st = JSON.parse(s.state_json) as { tunnelIp?: string; ownPubkeyHex?: string };
    const meshIp = (st.tunnelIp || '').split('/')[0].trim();
    const meshPubkey = (st.ownPubkeyHex || '').trim();
    if (!/^10\.44\.\d{1,3}\.\d{1,3}$/.test(meshIp) || !/^[0-9a-f]{64}$/i.test(meshPubkey)) return null;
    return { meshIp, meshPubkey };
  } catch {
    return null;
  }
}

/**
 * Connect to the mesh (join_mesh). Triggers the Android VPN consent dialog on first use; rejects if
 * the user denies it. Returns true if the VPN is running afterwards.
 */
export async function connectMesh(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const res = await invoke<{ running: boolean; state_json: string }>('plugin:mesh|join_mesh');
    return !!res?.running;
  } catch {
    return false;
  }
}

/**
 * Mark this device as a test target (persist the opt-in) so MeshSection's heartbeat keeps Wireless
 * Debugging alive whenever the mesh is up. We intentionally do NOT call prepare_adb here — the
 * heartbeat effect in MeshSection owns that, keyed on the persisted flag, which avoids a stale-closure
 * one-shot and keeps a single owner of WD lifecycle.
 */
export async function setTestTarget(on: boolean): Promise<void> {
  try {
    await persistSet(TEST_TARGET_KEY, on);
  } catch {
    /* best-effort */
  }
}
