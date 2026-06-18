import { create } from 'zustand';
import { PanelMode, RemoteMachine } from '../types';

/** Set after a one-QR pairing that bundled a mesh invite, to ask the user this device's role
 *  (controller vs test device) exactly once. Cleared when the prompt is answered/dismissed. */
export interface RolePrompt {
  machine: RemoteMachine;
  /** Active mesh network id from the QR; the bridge derives the test-device IP from it + our npub. */
  netid?: string;
  /** Whether the mesh invite was successfully imported by the deep-link handler. */
  meshImported: boolean;
}

interface UIStore {
  sidebarOpen: boolean;
  settingsOpen: boolean;
  newSessionOpen: boolean;
  newSessionMachine: RemoteMachine | null; // set when opening modal for a remote machine
  panelMode: PanelMode;
  rolePrompt: RolePrompt | null;
  setSidebarOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setNewSessionOpen: (open: boolean, machine?: RemoteMachine | null) => void;
  setPanelMode: (mode: PanelMode) => void;
  setRolePrompt: (prompt: RolePrompt | null) => void;
}

export const useUIStore = create<UIStore>((set) => ({
  sidebarOpen: true,
  settingsOpen: false,
  newSessionOpen: false,
  newSessionMachine: null,
  panelMode: 'session',
  rolePrompt: null,
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setNewSessionOpen: (open, machine) => set({ newSessionOpen: open, newSessionMachine: open ? (machine ?? null) : null }),
  setPanelMode: (mode) => set({ panelMode: mode }),
  setRolePrompt: (prompt) => set({ rolePrompt: prompt }),
}));
