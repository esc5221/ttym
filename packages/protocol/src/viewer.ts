/**
 * Viewer tabs — what `ttym open` attaches to a session.
 *
 * This is a wire contract: the server pushes it (CMD.VIEW), the CLI reads it
 * over HTTP, the web app renders it. One definition here, imported by all
 * three, so they cannot drift apart.
 *
 * What is *not* here is deliberate. The server keeps the file-system side
 * (root directory, access scope) to itself: a client only ever sees a
 * capability token and asks /view/<cap>/… for bytes. And the client keeps
 * the display side (active tab, pane-or-full, splitter) to itself: a tab
 * click on the desktop must not switch the tab on the phone.
 */

export type ViewKind = 'file' | 'dir' | 'url';

/** How the web app draws a tab. Decided by the server so the rule lives once. */
export type ViewRenderer = 'frame' | 'markdown' | 'table' | 'json' | 'code' | 'image' | 'dir';

export type ViewPresentation = 'pane' | 'full';

export interface ViewItem {
  id: string;
  /** Key for /view/<cap>/…; random, 128-bit. Only file and dir tabs have one. */
  cap?: string;
  kind: ViewKind;
  /** Absolute path (file/dir, realpath) or the URL itself. */
  target: string;
  /** Display name: basename, or the URL's host. */
  name: string;
  renderer: ViewRenderer;
  /** Bumped when the same target is opened again; the client remounts the view. */
  rev: number;
  openedAt: number;
}

/** The last `ttym open`: which tab to bring forward, and how. Each client acts on a serial once. */
export interface ViewOpenRequest {
  itemId: string;
  presentation: ViewPresentation;
  serial: number;
}

export interface ViewerState {
  /** Monotonic per session — a stale GET must not overwrite a newer push. */
  version: number;
  items: ViewItem[];
  lastOpen: ViewOpenRequest | null;
}

/** CMD.VIEW payload: the whole state, never a diff. `null` once the last tab closes. */
export interface ViewChangeEvent {
  sessionId: number;
  state: ViewerState | null;
}

/** Per-session cap on tabs. Beyond this, `open` refuses rather than evicting. */
export const VIEW_MAX_TABS = 32;
