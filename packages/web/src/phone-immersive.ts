import { useSyncExternalStore } from 'react';

/**
 * Phone: whether the focused pane takes the whole screen (no tab strip, no pane header).
 *
 * The strip lives in App and the header in the workspace screen, so the choice sits in a small
 * store both can read without one owning the other. It is this device's choice, kept in localStorage.
 */

const KEY = 'ttym-phone-immersive';
const listeners = new Set<() => void>();
let value: boolean | null = null;

function load(): boolean {
  if (value === null) {
    try { value = localStorage.getItem(KEY) === '1'; } catch { value = false; }
  }
  return value;
}

export function setPhoneImmersive(on: boolean): void {
  value = on;
  try { if (on) localStorage.setItem(KEY, '1'); else localStorage.removeItem(KEY); } catch {}
  for (const l of listeners) l();
}

export function usePhoneImmersive(): boolean {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, load);
}
