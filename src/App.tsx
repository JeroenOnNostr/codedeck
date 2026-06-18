import { useEffect } from 'react';
import { useUIStore } from './stores/uiStore';
import { useSessionStore } from './stores/sessionStore';
import { useDmStore } from './stores/dmStore';
import { useMediaQuery } from './hooks/useMediaQuery';
import { parsePublicKey, getPubkeyHex } from './services/nostrService';
import { generateSecretKey } from 'nostr-tools/pure';
import { useQuickPromptStore } from './stores/quickPromptStore';
import { useVoiceModeStore } from './stores/voiceModeStore';
import { initNotifications, setAppHidden } from './services/notificationService';
import { initPingAudio } from './services/pingSound';
import { hasActiveSubscriptions } from './services/bridgeService';
import { importMeshInvite } from './services/meshClient';
import { onOpenUrl, getCurrent } from '@tauri-apps/plugin-deep-link';
import { invoke } from '@tauri-apps/api/core';
import * as nip19 from 'nostr-tools/nip19';
import type { RemoteMachine } from './types';
import { SpeechProvider } from './contexts/SpeechContext';
import Sidebar from './components/Sidebar';
import MainPanel from './components/MainPanel';
import SettingsModal from './components/SettingsModal';
import NewSessionModal from './components/NewSessionModal';
import ErrorBoundary from './components/ErrorBoundary';
import UndoToast from './components/UndoToast';
import PairToast from './components/PairToast';
import RolePrompt from './components/RolePrompt';
import './styles/global.css';

function handleDeepLink(url: string): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'codedeck:') return;

    const npub = parsed.searchParams.get('npub');
    const relaysParam = parsed.searchParams.get('relays');
    const machineName = parsed.searchParams.get('machine') || 'Remote';
    const token = parsed.searchParams.get('token');

    if (!npub) return;
    const pubkeyHex = parsePublicKey(npub);
    if (!pubkeyHex) return;

    const relays = relaysParam
      ? relaysParam.split(',').map(r => decodeURIComponent(r)).filter(r => r.startsWith('wss://') || r.startsWith('ws://'))
      : ['wss://relay2.descendant.io', 'wss://relay.primal.net', 'wss://relay.nostr.band', 'wss://nos.lol'];

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

    // Auto-pairing: if the QR carried a token, send this phone's identity back to
    // the bridge so it pairs us with no manual npub entry. A key is guaranteed to
    // exist by the first-run auto-generation in the init effect.
    if (token && currentConfig.private_key_hex) {
      try {
        const ownHex = getPubkeyHex(hexToBytes(currentConfig.private_key_hex));
        const ownNpub = nip19.npubEncode(ownHex);
        useSessionStore.getState().pairWithMachine(machine, token, ownNpub, ownHex);
      } catch (err) {
        console.warn('[App] Failed to send pair-request:', err);
      }
    }

    // One-QR mesh onboarding: if the QR bundled a mesh invite, auto-import it here (single source of
    // truth — MeshSection only reflects state, it doesn't re-import), then ask the user this device's
    // role exactly once. Done last so pairing succeeds even if mesh import fails.
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
  } catch {
    // Malformed URL — ignore silently
  }
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export default function App() {
  const isWide = useMediaQuery('(min-width: 700px)');
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const newSessionOpen = useUIStore((s) => s.newSessionOpen);
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);
  useEffect(() => {
    const sessionActions = useSessionStore.getState();
    sessionActions.loadSessions();
    sessionActions.loadConfig();
    sessionActions.initEventListeners();
    initNotifications();
    initPingAudio();
    useQuickPromptStore.getState().loadPersisted();
    useVoiceModeStore.getState().loadPersisted();

    // Load persisted DMs first (includes Nostr private key), then init bridge
    useDmStore.getState().loadPersisted().then(() => {
      const dmState = useDmStore.getState();
      let nostrConfig = dmState.nostrConfig;

      // First-run: a fresh install has no keypair, so pairing AND DMs are dead
      // until the user pastes an nsec. Auto-generate one so the app works out of
      // the box. The user can still import an existing nsec in Settings (which
      // overwrites this). The same key powers both DMs and the bridge.
      if (!nostrConfig.private_key_hex) {
        const sk = generateSecretKey();
        const hex = bytesToHex(sk);
        dmState.updateNostrConfig({ ...nostrConfig, private_key_hex: hex });
        nostrConfig = useDmStore.getState().nostrConfig; // re-read after update
      }

      if (nostrConfig.private_key_hex) {
        useSessionStore.getState().initBridgeService(nostrConfig.private_key_hex);
      }
      dmState.connect();
      dmState.resolveAllProfiles();

      // Handle deep links (codedeck://pair?npub=...&relays=...&machine=...)
      getCurrent().then(urls => {
        if (urls) urls.forEach(handleDeepLink);
      }).catch(() => {});
      onOpenUrl(urls => {
        urls.forEach(handleDeepLink);
      }).catch(() => {});
    });
  }, []);

  // Manage DM + bridge lifecycle on background/foreground transitions
  useEffect(() => {
    const onVisibilityChange = () => {
      const dmState = useDmStore.getState();
      if (!dmState.nostrConfig.private_key_hex) return;

      setAppHidden(document.hidden);
      if (document.hidden) {
        dmState.disconnect();
        // Start foreground service to keep bridge relay alive on Android
        if (hasActiveSubscriptions()) {
          invoke('plugin:background-relay|start_service').catch(() => {});
        }
      } else {
        dmState.connect();
        // Stop foreground service (not needed in foreground)
        invoke('plugin:background-relay|stop_service').catch(() => {});
        // Safety net: reconnect bridge in case service was killed by OS
        useSessionStore.getState().reconnectBridge();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  // Track keyboard visibility — handles both Tauri adjustResize (window shrinks)
  // and browser overlay mode (visualViewport shrinks while window stays the same).
  // Also uses focusin/focusout as fallback: on Android 11+ adjustResize is
  // deprecated and viewport events may not fire in the WebView.
  useEffect(() => {
    let fullHeight = window.innerHeight;
    let focusOpen = false;   // tracks focus-based keyboard detection
    let blurTimer: number;

    const setKeyboard = (open: boolean) => {
      document.documentElement.setAttribute('data-keyboard-open', String(open));
    };

    const update = () => {
      const vvHeight = window.visualViewport?.height ?? window.innerHeight;
      // Use the smaller value: covers both resize and overlay keyboard modes
      const currentHeight = Math.min(window.innerHeight, vvHeight);

      // Track max height (resets on keyboard close / orientation change)
      if (currentHeight > fullHeight) fullHeight = currentHeight;

      const offset = fullHeight - currentHeight;
      document.documentElement.style.setProperty(
        '--keyboard-offset', `${Math.max(0, offset)}px`
      );
      document.documentElement.style.setProperty(
        '--app-height', `${currentHeight}px`
      );
      // Keyboard is open if viewport shrank OR an input is focused
      setKeyboard(offset > 150 || focusOpen);
    };

    const onFocusIn = (e: FocusEvent) => {
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) {
        clearTimeout(blurTimer);
        focusOpen = true;
        setKeyboard(true);
      }
    };

    const onFocusOut = () => {
      // Short delay: focus may move between inputs without the keyboard closing
      blurTimer = window.setTimeout(() => {
        const a = document.activeElement;
        if (!(a instanceof HTMLInputElement) && !(a instanceof HTMLTextAreaElement)) {
          focusOpen = false;
          update(); // let viewport offset decide (may still be open)
        }
      }, 120);
    };

    window.addEventListener('resize', update);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener('resize', update);
      vv.addEventListener('scroll', update);
    }
    update();

    return () => {
      clearTimeout(blurTimer);
      window.removeEventListener('resize', update);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      if (vv) {
        vv.removeEventListener('resize', update);
        vv.removeEventListener('scroll', update);
      }
    };
  }, []);

  return (
    <SpeechProvider>
    <div style={{
      display: 'flex',
      height: '100%',
      width: '100%',
      overflow: 'hidden',
      background: 'var(--bg-black)',
    }}>
      {/* Sidebar - inline on wide, drawer on narrow */}
      <ErrorBoundary>
      {isWide ? (
        <Sidebar />
      ) : (
        <>
          {sidebarOpen && (
            <div
              style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(0,0,0,0.7)',
                zIndex: 99,
              }}
              onClick={() => setSidebarOpen(false)}
            />
          )}
          <div style={{
            position: 'fixed',
            left: sidebarOpen ? 0 : -280,
            top: 0,
            bottom: 0,
            width: 280,
            zIndex: 100,
            transition: 'left 0.2s ease',
          }}>
            <Sidebar />
          </div>
        </>
      )}
      </ErrorBoundary>

      <MainPanel isWide={isWide} />

      <UndoToast />
      <PairToast />

      <ErrorBoundary>
      {settingsOpen && <SettingsModal />}
      {newSessionOpen && <NewSessionModal />}
      <RolePrompt />
      </ErrorBoundary>
    </div>
    </SpeechProvider>
  );
}
