import { useSyncExternalStore } from 'react';

/**
 * Which grid panes show reader mode, and how their input area is drawn.
 *
 * Kept per session id in localStorage (this browser's choice) behind a small
 * store, because the pane's header (the switch) and its body (the page) are
 * different components that must agree without one owning the other.
 */

const PANES_KEY = 'ttym-pane-reader';
const DOCK_KEY = 'ttym-pane-reader-dock';

export type PaneDock = 'native' | 'styled';

const listeners = new Set<() => void>();
let panes: ReadonlySet<number> | null = null;
let dock: PaneDock | null | undefined;

function loadPanes(): ReadonlySet<number> {
  if (panes) return panes;
  try {
    const raw = JSON.parse(localStorage.getItem(PANES_KEY) ?? '[]');
    panes = new Set(Array.isArray(raw) ? raw.filter((n): n is number => Number.isInteger(n)) : []);
  } catch { panes = new Set(); }
  return panes;
}

function emit() { for (const l of listeners) l(); }
function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }

export function setPaneReader(sid: number, on: boolean): void {
  const next = new Set(loadPanes());
  if (on) next.add(sid); else next.delete(sid);
  panes = next;
  try { localStorage.setItem(PANES_KEY, JSON.stringify([...next])); } catch {}
  emit();
}

export const isPaneReader = (sid: number): boolean => loadPanes().has(sid);

export function usePaneReader(sid: number): boolean {
  return useSyncExternalStore(subscribe, () => loadPanes().has(sid));
}

/** The person's choice of input-area style for panes, or null while they haven't chosen (the pane then picks by its width). */
function loadDock(): PaneDock | null {
  if (dock !== undefined) return dock;
  try {
    const v = localStorage.getItem(DOCK_KEY);
    dock = v === 'native' || v === 'styled' ? v : null;
  } catch { dock = null; }
  return dock;
}

export function setPaneDock(mode: PaneDock): void {
  dock = mode;
  try { localStorage.setItem(DOCK_KEY, mode); } catch {}
  emit();
}

export function usePaneDock(): PaneDock | null {
  return useSyncExternalStore(subscribe, loadDock);
}

/** Whether reader mode shows a message while the agent is still writing it (read off the terminal). On unless switched off in this browser. */
const LIVE_KEY = 'ttym-reader-live';
let liveOn: boolean | undefined;

function loadLive(): boolean {
  if (liveOn !== undefined) return liveOn;
  try { liveOn = localStorage.getItem(LIVE_KEY) !== 'off'; } catch { liveOn = true; }
  return liveOn;
}

export function setReaderLive(on: boolean): void {
  liveOn = on;
  try { localStorage.setItem(LIVE_KEY, on ? 'on' : 'off'); } catch {}
  emit();
}

export function useReaderLive(): boolean {
  return useSyncExternalStore(subscribe, loadLive);
}
