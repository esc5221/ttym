import { useSyncExternalStore } from 'react';

/**
 * What the web composer holds for a pane, kept outside the component.
 *
 * The field is unmounted and mounted again more often than it looks: the agent repaints its prompt (a turn
 * starting or ending), a dialog takes the prompt's place, a long draft moves the field into the page. State
 * inside the component went with it — a draft written during a turn was gone when the turn ended (dev,
 * 2026-11-08). Kept here per session id, and the draft also in sessionStorage so a reload keeps it.
 */
export interface ComposerState {
  /** Our text, or null while the field mirrors the agent's prompt. */
  draft: string | null;
  /** Messages on their way (the server types, presses Enter and checks). */
  pending: number;
}

interface Extra {
  /** Sends go one after another. */
  chain: Promise<void>;
  /** Texts we sent or handed over, newest last: known word for word when the agent shows one back wrapped. */
  sent: string[];
  /** What we emptied from the agent's prompt when taking it over; the screen can still show it for a moment. */
  takenOver: string;
  /** Where the caret was and whether the field had the keyboard when it went away. */
  caret: number | null;
  focused: boolean;
}

const KEY = (sid: number) => `ttym-composer-draft-${sid}`;
const states = new Map<number, ComposerState>();
const extras = new Map<number, Extra>();
const listeners = new Map<number, Set<() => void>>();

export function composerState(sid: number): ComposerState {
  let s = states.get(sid);
  if (!s) {
    let draft: string | null = null;
    try { draft = sessionStorage.getItem(KEY(sid)) || null; } catch {}
    s = { draft, pending: 0 };
    states.set(sid, s);
  }
  return s;
}

export function updateComposer(sid: number, patch: (s: ComposerState) => Partial<ComposerState>): void {
  const cur = composerState(sid);
  const p = patch(cur);
  const next = { ...cur, ...p };
  if (next.draft === cur.draft && next.pending === cur.pending) return;
  states.set(sid, next);
  if ('draft' in p) {
    try {
      if (next.draft) sessionStorage.setItem(KEY(sid), next.draft);
      else sessionStorage.removeItem(KEY(sid));
    } catch {}
  }
  for (const l of listeners.get(sid) ?? []) l();
}

export function composerExtra(sid: number): Extra {
  let e = extras.get(sid);
  if (!e) { e = { chain: Promise.resolve(), sent: [], takenOver: '', caret: null, focused: false }; extras.set(sid, e); }
  return e;
}

export function useComposerState(sid: number): ComposerState {
  return useSyncExternalStore(
    (l) => {
      let set = listeners.get(sid);
      if (!set) { set = new Set(); listeners.set(sid, set); }
      set.add(l);
      return () => { set!.delete(l); };
    },
    () => composerState(sid),
  );
}
