/**
 * Pairing-link handling — the single source of truth for `codedeck://pair?...` URLs.
 *
 * The bridge hands out one URL, and it can reach this app two ways:
 *   1. The phone's camera scans the QR and the OS fires a deep link (see App.tsx).
 *   2. The user pastes the link into Settings → Remote Machines (see SettingsModal.tsx).
 *
 * (2) exists because a phone with no working camera has no other way in: the manual
 * npub form can't send a pair-request, since that needs the one-time `token` that
 * only ever appears in this URL.
 */

import * as nip19 from 'nostr-tools/nip19';
import { useUIStore } from '../stores/uiStore';
import { useSessionStore } from '../stores/sessionStore';
import { useDmStore } from '../stores/dmStore';
import { parsePublicKey, getPubkeyHex } from './nostrService';
import { importMeshInvite } from './meshClient';
import type { RemoteMachine } from '../types';

const FALLBACK_RELAYS = [
  'wss://relay2.descendant.io',
  'wss://relay.primal.net',
  'wss://relay.nostr.band',
  'wss://nos.lol',
];

export type PairingLinkResult =
  | {
      ok: true;
      machine: RemoteMachine;
      /** False when the machine was added but the bridge won't learn about this phone. */
      pairRequestSent: boolean;
      /** Set when `pairRequestSent` is false, explaining why. */
      note?: string;
    }
  | { ok: false; error: string };

/**
 * Pull a `codedeck://` URL out of arbitrary pasted text.
 *
 * Chat apps wrap links, prepend prose ("here you go: codedeck://…") and glue
 * sentence punctuation onto the end, so an exact-match check would reject links
 * that are perfectly usable.
 */
export function extractPairingUrl(raw: string): string | null {
  const match = raw.match(/codedeck:\/\/\S+/i);
  if (!match) return null;
  // Trailing punctuation is prose, never part of the query string — the mesh
  // invite is base64url (`-`/`_` only) and everything else is percent-encoded.
  return match[0].replace(/[)\]}>,.;:!?'"]+$/, '');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Parse and apply a pairing URL: register the machine, merge its relays/blossom
 * config, fire the token-gated pair-request, and import any bundled mesh invite.
 */
export function applyPairingLink(url: string): PairingLinkResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "Couldn't read that link — copy it again from VSCode." };
  }

  if (parsed.protocol !== 'codedeck:') {
    return { ok: false, error: 'Not a Codedeck pairing link.' };
  }

  const npub = parsed.searchParams.get('npub');
  const relaysParam = parsed.searchParams.get('relays');
  const machineName = parsed.searchParams.get('machine') || 'Remote';
  const token = parsed.searchParams.get('token');

  if (!npub) {
    return { ok: false, error: 'This link is missing a valid bridge npub.' };
  }
  const pubkeyHex = parsePublicKey(npub);
  if (!pubkeyHex) {
    return { ok: false, error: 'This link is missing a valid bridge npub.' };
  }

  const relays = relaysParam
    ? relaysParam.split(',').map(r => decodeURIComponent(r)).filter(r => r.startsWith('wss://') || r.startsWith('ws://'))
    : FALLBACK_RELAYS;

  const machine: RemoteMachine = {
    hostname: machineName,
    npub: npub.startsWith('npub1') ? npub : nip19.npubEncode(pubkeyHex),
    pubkeyHex,
    relays,
    connected: false,
  };

  useSessionStore.getState().addMachine(machine);

  // Apply pairing config to DM store (blossom server + relay merge)
  const blossomParam = parsed.searchParams.get('blossom');
  const dmState = useDmStore.getState();
  const currentConfig = dmState.nostrConfig;
  const currentRelays = currentConfig.relays;
  const missingRelays = relays.filter(r => !currentRelays.includes(r));
  const needsUpdate = missingRelays.length > 0 || (blossomParam && currentConfig.blossomServer !== blossomParam);

  if (needsUpdate) {
    dmState.updateNostrConfig({
      ...currentConfig,
      relays: missingRelays.length > 0 ? [...currentRelays, ...missingRelays] : currentRelays,
      ...(blossomParam ? { blossomServer: blossomParam } : {}),
    });
  }

  // One-QR mesh onboarding: if the link bundled a mesh invite, auto-import it here (single source of
  // truth — MeshSection only reflects state, it doesn't re-import), then ask the user this device's
  // role exactly once. Fired before the pair-request return so pairing still reports its own status.
  const meshInvite = parsed.searchParams.get('mesh');
  const netid = parsed.searchParams.get('netid') || undefined;
  if (meshInvite) {
    importMeshInvite(meshInvite)
      .then((meshImported) => {
        useUIStore.getState().setRolePrompt({ machine, netid, meshImported });
      })
      .catch(() => {
        // Import failed (e.g. desktop) — still offer the role prompt so the user can proceed.
        useUIStore.getState().setRolePrompt({ machine, netid, meshImported: false });
      });
  }

  // Auto-pairing: if the link carried a token, send this phone's identity back to
  // the bridge so it pairs us with no manual npub entry. A key is guaranteed to
  // exist by the first-run auto-generation in App's init effect.
  if (!token) {
    return {
      ok: true,
      machine,
      pairRequestSent: false,
      note: `Added ${machineName}, but this link has no pairing token — the bridge won't see this phone. Generate a fresh link in VSCode.`,
    };
  }

  // Re-read: updateNostrConfig above may have replaced the object.
  const privateKeyHex = useDmStore.getState().nostrConfig.private_key_hex;
  if (!privateKeyHex) {
    return {
      ok: true,
      machine,
      pairRequestSent: false,
      note: `Added ${machineName}, but this phone has no Nostr key yet — set one under Nostr Identity, then paste the link again.`,
    };
  }

  try {
    const ownHex = getPubkeyHex(hexToBytes(privateKeyHex));
    const ownNpub = nip19.npubEncode(ownHex);
    useSessionStore.getState().pairWithMachine(machine, token, ownNpub, ownHex);
  } catch (err) {
    console.warn('[pairingLink] Failed to send pair-request:', err);
    return {
      ok: true,
      machine,
      pairRequestSent: false,
      note: `Added ${machineName}, but the pairing request could not be sent.`,
    };
  }

  return { ok: true, machine, pairRequestSent: true };
}
