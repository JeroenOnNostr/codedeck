import { useEffect } from 'react';
import { useUIStore } from './stores/uiStore';
import { useSessionStore } from './stores/sessionStore';
import { useDmStore } from './stores/dmStore';
import { useMediaQuery } from './hooks/useMediaQuery';
import { generateSecretKey } from 'nostr-tools/pure';
import { useQuickPromptStore } from './stores/quickPromptStore';
import { initNotifications, setAppHidden } from './services/notificationService';
import { initPingAudio } from './services/pingSound';
import { hasActiveSubscriptions } from './services/bridgeService';
import { applyPairingLink } from './services/pairingLink';
import { onOpenUrl, getCurrent } from '@tauri-apps/plugin-deep-link';
import { invoke } from '@tauri-apps/api/core';
import Sidebar from './components/Sidebar';
import MainPanel from './components/MainPanel';
import SettingsModal from './components/SettingsModal';
import NewSessionModal from './components/NewSessionModal';
import ErrorBoundary from './components/ErrorBoundary';
import UndoToast from './components/UndoToast';
import PairToast from './components/PairToast';
import RolePrompt from './components/RolePrompt';
import './styles/global.css';

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

      // Handle deep links (codedeck://pair?npub=...&relays=...&machine=...). Failures
      // stay silent here — an OS-delivered link the user never typed has no surface to
      // report into. The paste path in Settings surfaces the same errors to the user.
      getCurrent().then(urls => {
        if (urls) urls.forEach(url => applyPairingLink(url));
      }).catch(() => {});
      onOpenUrl(urls => {
        urls.forEach(url => applyPairingLink(url));
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
            height: 'var(--app-height, 100%)',
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
  );
}
