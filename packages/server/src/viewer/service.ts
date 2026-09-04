/**
 * What `ttym open` means: turn targets into tabs.
 *
 * One call, many targets, one state change, one push — `ttym open a b c`
 * must not arrive at the browser as three flickers. Each target is
 * classified (url / file / dir), fixed to its realpath, given a renderer,
 * and either merged into an existing tab (same target → rev+1, so a
 * regenerated report reloads) or appended with a fresh capability.
 *
 * The scope a tab may serve is decided here and only here:
 *
 *   file           exact + sibling static assets  (`assets`)
 *   dir            the whole subtree              (`tree`)
 *   file --root d  the subtree under d            (`tree`)
 *
 * A file's parent directory is never a root by itself. `~/x.html` would
 * otherwise be a read capability on the home directory, and the server
 * cannot tell an <img> from a fetch(".ssh/id_rsa") — so the asset rule is
 * an extension allowlist (see content.ts), and widening is the user's
 * explicit act.
 */
import { open as openFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { VIEW_MAX_TABS, type ViewPresentation, type ViewRenderer } from '@ttym/protocol';
import { ViewerStore, type StoredItem, type StoredState, type ViewScope } from './store.js';

export interface OpenOptions {
  presentation?: ViewPresentation;
  /** Absolute directory; widens file tabs to this subtree. Must contain the file. */
  root?: string;
}

export type OpenResult =
  | { target: string; ok: true; id: string; rev: number }
  | { target: string; ok: false; error: string };

const RENDERER_BY_EXT: Record<string, ViewRenderer> = {
  '.html': 'frame', '.htm': 'frame', '.pdf': 'frame',
  '.md': 'markdown', '.markdown': 'markdown',
  '.csv': 'table', '.tsv': 'table', '.jsonl': 'table', '.ndjson': 'table',
  '.json': 'json',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image', '.svg': 'image', '.ico': 'image', '.avif': 'image',
};

const CODE_EXT = new Set(['.py', '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs', '.go', '.rs', '.rb', '.java', '.c', '.cpp', '.h', '.hpp',
  '.cs', '.swift', '.kt', '.scala', '.sh', '.bash', '.zsh', '.fish', '.sql', '.r', '.lua', '.pl', '.php', '.css', '.scss', '.less',
  '.xml', '.toml', '.yaml', '.yml', '.ini', '.cfg', '.conf', '.txt', '.log', '.gitignore', '.env', '.dockerfile', '.makefile', '.cmake', '.diff', '.patch']);

/** Text or not, for files with no extension: 8 KB with no NUL byte is text. */
async function looksLikeText(path: string): Promise<boolean> {
  let handle;
  try { handle = await openFile(path, 'r'); } catch { return false; }
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    for (let i = 0; i < bytesRead; i++) if (buf[i] === 0) return false;
    return true;
  } finally { await handle.close().catch(() => {}); }
}

export async function rendererForFile(path: string): Promise<ViewRenderer> {
  const ext = extname(path).toLowerCase();
  if (RENDERER_BY_EXT[ext]) return RENDERER_BY_EXT[ext]!;
  if (CODE_EXT.has(ext)) return 'code';
  const name = basename(path).toLowerCase();
  if (name === 'makefile' || name === 'dockerfile') return 'code';
  // Unknown: text reads as code; binary goes to the browser, which will download it.
  return (await looksLikeText(path)) ? 'code' : 'frame';
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

function newId(existing: Set<string>): string {
  for (;;) {
    const id = randomBytes(3).toString('hex');
    if (!existing.has(id)) return id;
  }
}

function newCap(): string {
  return randomBytes(16).toString('hex');
}

type Classified =
  | { kind: 'url'; target: string; name: string; renderer: 'frame' }
  | { kind: 'file'; target: string; name: string; renderer: ViewRenderer; root: string; scope: ViewScope }
  | { kind: 'dir'; target: string; name: string; renderer: ViewRenderer; root: string; scope: 'tree' };

async function classify(raw: string, opts: OpenOptions): Promise<{ ok: true; value: Classified } | { ok: false; error: string }> {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, error: 'target required' };
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      return { ok: true, value: { kind: 'url', target: url.toString(), name: url.host || text, renderer: 'frame' } };
    } catch { return { ok: false, error: `invalid url: ${text}` }; }
  }
  if (!text.startsWith('/')) return { ok: false, error: `path must be absolute: ${text}` };
  let real: string;
  try { real = await realpath(text); } catch { return { ok: false, error: `not found: ${text}` }; }
  let info;
  try { info = await stat(real); } catch { return { ok: false, error: `not found: ${text}` }; }

  if (info.isDirectory()) {
    let hasIndex = false;
    try { hasIndex = (await stat(`${real}/index.html`)).isFile(); } catch {}
    return { ok: true, value: { kind: 'dir', target: real, name: basename(real) || real, renderer: hasIndex ? 'frame' : 'dir', root: real, scope: 'tree' } };
  }
  if (!info.isFile()) return { ok: false, error: `not a file or directory: ${text}` };

  const renderer = await rendererForFile(real);
  if (opts.root) {
    let root: string;
    try { root = await realpath(opts.root); } catch { return { ok: false, error: `root not found: ${opts.root}` }; }
    if (!isUnder(real, root)) return { ok: false, error: `${text} is not under --root ${opts.root}` };
    return { ok: true, value: { kind: 'file', target: real, name: basename(real), renderer, root, scope: 'tree' } };
  }
  return { ok: true, value: { kind: 'file', target: real, name: basename(real), renderer, root: dirname(real), scope: 'assets' } };
}

export class ViewerService {
  constructor(private readonly store: ViewerStore) {}

  async open(sessionId: number, targets: string[], opts: OpenOptions = {}): Promise<{ state: StoredState | null; results: OpenResult[] }> {
    const current = this.store.get(sessionId);
    const items: StoredItem[] = current ? current.items.map((item) => ({ ...item })) : [];
    const ids = new Set(items.map((item) => item.id));
    const results: OpenResult[] = [];
    let lastItemId: string | null = null;
    const now = Date.now();

    for (const raw of targets) {
      const classified = await classify(raw, opts);
      if (!classified.ok) { results.push({ target: raw, ok: false, error: classified.error }); continue; }
      const next = classified.value;
      const at = items.findIndex((item) => item.kind === next.kind && item.target === next.target);
      if (at !== -1) {
        // Same target again: one tab, one more rev. Scope may widen (--root)
        // but never narrows behind the user's back.
        const prev = items[at]!;
        const widened = next.kind === 'file' && next.scope === 'tree' && prev.scope !== 'tree';
        items[at] = {
          ...prev,
          rev: prev.rev + 1,
          openedAt: now,
          renderer: next.renderer,
          ...(widened ? { root: next.root, scope: 'tree' } : null),
        };
        results.push({ target: raw, ok: true, id: prev.id, rev: prev.rev + 1 });
        lastItemId = prev.id;
        continue;
      }
      if (items.length >= VIEW_MAX_TABS) { results.push({ target: raw, ok: false, error: `too many tabs (max ${VIEW_MAX_TABS})` }); continue; }
      const id = newId(ids);
      ids.add(id);
      const item: StoredItem = {
        id, kind: next.kind, target: next.target, name: next.name, renderer: next.renderer, rev: 1, openedAt: now,
      };
      if (next.kind !== 'url') { item.cap = newCap(); item.root = next.root; item.scope = next.scope; }
      items.push(item);
      results.push({ target: raw, ok: true, id, rev: 1 });
      lastItemId = id;
    }

    if (lastItemId === null) return { state: current, results }; // nothing changed — no push
    const serial = (current?.serial ?? 0) + 1;
    const state: StoredState = {
      version: (current?.version ?? 0) + 1,
      items,
      serial,
      lastOpen: { itemId: lastItemId, presentation: opts.presentation ?? 'pane', serial },
    };
    this.store.set(sessionId, state);
    return { state, results };
  }

  close(sessionId: number, itemId: string): StoredState | null {
    const current = this.store.get(sessionId);
    if (!current || !current.items.some((item) => item.id === itemId)) return current;
    const items = current.items.filter((item) => item.id !== itemId);
    const state: StoredState | null = items.length === 0 ? null : {
      ...current,
      version: current.version + 1,
      items,
      lastOpen: current.lastOpen?.itemId === itemId ? null : current.lastOpen,
    };
    this.store.set(sessionId, state);
    return state;
  }

  closeAll(sessionId: number): void {
    if (!this.store.get(sessionId)) return;
    this.store.set(sessionId, null);
  }

  /** Match the way `open` normalised the target: realpath for paths, URL.toString for urls. */
  async findByTarget(sessionId: number, raw: string): Promise<StoredItem | null> {
    const current = this.store.get(sessionId);
    if (!current) return null;
    const text = String(raw ?? '').trim();
    let key = text;
    if (/^https?:\/\//i.test(text)) { try { key = new URL(text).toString(); } catch {} }
    else { try { key = await realpath(text); } catch {} }
    return current.items.find((item) => item.target === key) ?? null;
  }
}
