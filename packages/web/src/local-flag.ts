import { useSyncExternalStore } from 'react';

/**
 * A yes/no choice this device remembers (localStorage), readable from any component without one
 * owning it: the two ends of a setting are often far apart (a bar in App, a button in a pane).
 * `false` is stored as "no key".
 */
export function localFlag(key: string): { use: () => boolean; set: (on: boolean) => void } {
  const listeners = new Set<() => void>();
  let value: boolean | null = null;
  const load = (): boolean => {
    if (value === null) {
      try { value = localStorage.getItem(key) === '1'; } catch { value = false; }
    }
    return value;
  };
  return {
    use: () => useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, load),
    set: (on) => {
      value = on;
      try { if (on) localStorage.setItem(key, '1'); else localStorage.removeItem(key); } catch {}
      for (const l of listeners) l();
    },
  };
}
