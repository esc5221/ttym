/**
 * Where viewer tabs live: ~/.ttym/<runtime>/viewer.json, one entry per session.
 *
 * Not in session meta on purpose. The public annotations PATCH accepts any
 * key the server does not own, so a `views` annotation could be rewritten
 * with `root: "/"` and the open endpoint's checks would mean nothing. This
 * store has one writer — the viewer service — and the file-system half of
 * each tab (root, scope) never leaves the process.
 *
 * Persistence follows WorkspaceStore: in-memory map, atomic tmp+rename,
 * microtask-debounced save, flush() for shutdown and tests.
 */
import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ViewItem, ViewerState, ViewChangeEvent } from '@ttym/protocol';

export type ViewScope = 'exact' | 'assets' | 'tree';

/** A tab as the server knows it: the public item plus what the client must not see. */
export interface StoredItem extends ViewItem {
  /** Directory the capability may read from. Absent for url tabs. */
  root?: string;
  scope?: ViewScope;
}

export interface StoredState extends Omit<ViewerState, 'items'> {
  items: StoredItem[];
  /** Serial of the last open request — kept here so it survives a restart. */
  serial: number;
}

interface StoreFile {
  version: 1;
  sessions: Record<string, StoredState>;
}

export function toPublicItem(item: StoredItem): ViewItem {
  const { root: _root, scope: _scope, ...pub } = item;
  return pub;
}

export function toPublicState(state: StoredState): ViewerState {
  return { version: state.version, items: state.items.map(toPublicItem), lastOpen: state.lastOpen };
}

export class ViewerStore {
  private readonly filePath: string;
  private states = new Map<number, StoredState>();
  private caps = new Map<string, { sessionId: number; itemId: string }>();
  private dirty = false;
  private savePromise: Promise<void> | null = null;
  private saveQueued = false;
  private inFlight: Promise<void> | null = null;
  private listeners = new Set<(event: ViewChangeEvent) => void>();

  constructor(runtimeDir: string) {
    this.filePath = resolve(runtimeDir, 'viewer.json');
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const data = JSON.parse(raw) as StoreFile;
      if (data.version !== 1 || !data.sessions || typeof data.sessions !== 'object') return;
      for (const [key, state] of Object.entries(data.sessions)) {
        const sessionId = Number(key);
        if (!Number.isInteger(sessionId) || !state || !Array.isArray(state.items)) continue;
        this.states.set(sessionId, state);
        for (const item of state.items) if (item.cap) this.caps.set(item.cap, { sessionId, itemId: item.id });
      }
    } catch {}
  }

  get(sessionId: number): StoredState | null {
    return this.states.get(sessionId) ?? null;
  }

  sessionIds(): number[] {
    return Array.from(this.states.keys());
  }

  /** The tab behind a /view/<cap>/… request, or null. */
  byCap(cap: string): { sessionId: number; item: StoredItem } | null {
    const ref = this.caps.get(cap);
    if (!ref) return null;
    const item = this.states.get(ref.sessionId)?.items.find((i) => i.id === ref.itemId);
    return item ? { sessionId: ref.sessionId, item } : null;
  }

  /** Replace a session's state (null removes it), persist, and announce the public projection. */
  set(sessionId: number, state: StoredState | null): void {
    const previous = this.states.get(sessionId);
    if (previous) for (const item of previous.items) if (item.cap) this.caps.delete(item.cap);
    if (state && state.items.length > 0) {
      this.states.set(sessionId, state);
      for (const item of state.items) if (item.cap) this.caps.set(item.cap, { sessionId, itemId: item.id });
    } else {
      this.states.delete(sessionId);
    }
    this.scheduleSave();
    const event: ViewChangeEvent = { sessionId, state: state && state.items.length > 0 ? toPublicState(state) : null };
    for (const listener of this.listeners) {
      try { listener(event); } catch {}
    }
  }

  /** Drop states for sessions that no longer exist. Called by the gc sweep, silently. */
  prune(keep: Set<number>): number {
    let removed = 0;
    for (const sessionId of Array.from(this.states.keys())) {
      if (keep.has(sessionId)) continue;
      const state = this.states.get(sessionId)!;
      for (const item of state.items) if (item.cap) this.caps.delete(item.cap);
      this.states.delete(sessionId);
      removed++;
    }
    if (removed > 0) this.scheduleSave();
    return removed;
  }

  onChange(listener: (event: ViewChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private scheduleSave(): void {
    if (this.dirty) return;
    this.dirty = true;
    this.inFlight = new Promise<void>((done) => {
      queueMicrotask(() => {
        if (!this.dirty) { done(); return; }
        this.save().catch(() => {}).finally(done);
      });
    });
  }

  async save(): Promise<void> {
    if (this.savePromise) {
      this.saveQueued = true;
      await this.savePromise;
      if (!this.dirty) return;
    }
    this.savePromise = (async () => {
      do {
        this.saveQueued = false;
        const data: StoreFile = { version: 1, sessions: {} };
        for (const [sessionId, state] of this.states) data.sessions[String(sessionId)] = state;
        const tmpPath = this.filePath + '.tmp';
        await writeFile(tmpPath, JSON.stringify(data, null, 2));
        await rename(tmpPath, this.filePath);
        this.dirty = false;
      } while (this.saveQueued || this.dirty);
    })();
    try { await this.savePromise; } finally { this.savePromise = null; }
  }

  async flush(): Promise<void> {
    if (this.inFlight) await this.inFlight;
    if (this.savePromise) await this.savePromise;
  }
}
