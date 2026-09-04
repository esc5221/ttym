/**
 * Bytes for the viewer: GET /view/<cap>/<rel>.
 *
 * The capability names a tab; the tab's scope says which files under its
 * root may answer. The check is realpath containment, not string prefix —
 * a symlink out of the root passes the string and fails here — and the
 * registration realpath (service.ts) is re-derived on every request. The
 * window between that realpath and open() remains; a local user racing
 * their own file tree is not a threat this guards against.
 *
 * A file comes with the headers the browser-side renderers lean on: weak
 * ETag → 304, single Range → 206 (table views read a megabyte at a time),
 * nosniff, and no-cache so a regenerated report is never a stale one.
 */
import { createReadStream } from 'node:fs';
import { open as openFile, readdir, realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import type { StoredItem } from './store.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.markdown': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.wasm': 'application/wasm',
};

/**
 * What a file tab may serve besides the file itself. Static presentation
 * assets only — nothing that habitually carries secrets (.json, .env, .txt
 * are not here). To read more, open the directory or pass --root.
 */
export const ASSET_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.ico',
  '.css', '.js', '.mjs', '.map', '.woff', '.woff2', '.ttf', '.otf', '.mp4', '.webm', '.mp3', '.wav', '.wasm']);

/** Directory listing hides these — noise, or things nobody meant to browse. */
const HIDDEN = new Set(['node_modules', '__pycache__', '.git', '.DS_Store']);
export const DIR_MAX_ENTRIES = 2000;

export function contentTypeFor(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return MIME[ext] ?? 'application/octet-stream';
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

export type Resolved = { ok: true; path: string } | { ok: false; status: 403 | 404 };

/**
 * Relative URL path → absolute path this tab may serve. Segment checks, then
 * realpath containment, then the tab's scope.
 */
export async function resolveForItem(item: StoredItem, rel: string): Promise<Resolved> {
  const root = item.root;
  if (!root || !item.scope) return { ok: false, status: 404 };
  const segments = rel.split('/').filter((s) => s.length > 0);
  for (const seg of segments) {
    if (seg === '.' || seg === '..') return { ok: false, status: 403 };
  }
  const joined = resolve(root, ...segments);
  let real: string;
  try { real = await realpath(joined); } catch { return { ok: false, status: 404 }; }
  if (!isUnder(real, root)) return { ok: false, status: 403 };

  switch (item.scope) {
    case 'tree':
      return { ok: true, path: real };
    case 'exact':
      return real === item.target ? { ok: true, path: real } : { ok: false, status: 403 };
    case 'assets':
      if (real === item.target) return { ok: true, path: real };
      return ASSET_EXT.has(extname(real).toLowerCase()) ? { ok: true, path: real } : { ok: false, status: 403 };
  }
}

export interface DirEntry { n: string; d: boolean; s: number; m: number }
export interface DirListing { path: string; entries: DirEntry[]; truncated: boolean }

export async function listDirectory(root: string, dir: string): Promise<DirListing> {
  const names = await readdir(dir);
  const entries: DirEntry[] = [];
  let truncated = false;
  for (const name of names) {
    if (name.startsWith('.') || HIDDEN.has(name)) continue;
    if (entries.length >= DIR_MAX_ENTRIES) { truncated = true; break; }
    try {
      const info = await stat(join(dir, name));
      entries.push({ n: name, d: info.isDirectory(), s: info.isDirectory() ? 0 : info.size, m: Math.floor(info.mtimeMs / 1000) });
    } catch { /* broken symlink: skip */ }
  }
  entries.sort((a, b) => (a.d === b.d ? a.n.toLowerCase().localeCompare(b.n.toLowerCase()) : a.d ? -1 : 1));
  const relParts = dir === root ? [] : dir.slice(root.length).split(sep).filter(Boolean);
  const path = '/' + relParts.map(encodeURIComponent).join('/') + (relParts.length ? '/' : '');
  return { path, entries, truncated };
}

/**
 * Read-only CORS on purpose. The web app may live on another origin than
 * the server (ttym-ui.* → ttym.*, or the desktop shell) and its renderers
 * fetch bytes from here with a Range header, which forces a preflight. The
 * capability token in the URL is the secret; the origin never was.
 */
export const BASE_HEADERS = {
  'Cache-Control': 'private, no-cache',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length, ETag, Accept-Ranges',
};

export const PREFLIGHT_HEADERS = {
  ...BASE_HEADERS,
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, If-None-Match, If-Range',
  'Access-Control-Max-Age': '600',
};

export async function serveFile(req: IncomingMessage, res: ServerResponse, filePath: string): Promise<void> {
  let handle;
  try { handle = await openFile(filePath, 'r'); } catch { res.writeHead(404, BASE_HEADERS); res.end('not found'); return; }
  try {
    const info = await handle.stat();
    if (!info.isFile()) { res.writeHead(404, BASE_HEADERS); res.end('not found'); return; }
    const size = info.size;
    const etag = `W/"${Math.floor(info.mtimeMs * 1000)}-${size}"`;
    const base: Record<string, string | number> = {
      ...BASE_HEADERS,
      'Content-Type': contentTypeFor(filePath),
      'Accept-Ranges': 'bytes',
      'ETag': etag,
    };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, base); res.end(); return; }

    const rangeHeader = req.headers.range;
    const ifRange = req.headers['if-range'];
    let start = 0;
    let end = size - 1;
    let partial = false;
    if (rangeHeader && (!ifRange || ifRange === etag)) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
      if (m && (m[1] || m[2])) {
        if (m[1] === '') {
          start = Math.max(0, size - parseInt(m[2]!, 10));
        } else {
          start = parseInt(m[1]!, 10);
          end = m[2] === '' ? size - 1 : Math.min(size - 1, parseInt(m[2]!, 10));
        }
        if (size === 0 || start >= size || start > end) {
          res.writeHead(416, { ...base, 'Content-Range': `bytes */${size}` });
          res.end();
          return;
        }
        partial = true;
      }
    }
    const length = end - start + 1;
    const headers = { ...base, 'Content-Length': length };
    if (partial) res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}` });
    else res.writeHead(200, headers);
    if (req.method === 'HEAD' || length === 0) { res.end(); return; }
    await new Promise<void>((done) => {
      const stream = createReadStream(filePath, { fd: handle!.fd, autoClose: false, start, end });
      stream.on('error', () => { res.destroy(); done(); });
      stream.on('end', () => done());
      stream.pipe(res);
    });
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Answer one /view/<cap>/<rel> request for a tab. A directory answers with
 * its index.html when it has one, else a JSON listing (tree scope only —
 * an assets-scope tab has no directory to show).
 */
export async function serveContent(req: IncomingMessage, res: ServerResponse, item: StoredItem, rel: string): Promise<void> {
  const hit = await resolveForItem(item, rel);
  if (!hit.ok) { res.writeHead(hit.status, BASE_HEADERS); res.end(hit.status === 403 ? 'denied' : 'not found'); return; }
  let info;
  try { info = await stat(hit.path); } catch { res.writeHead(404, BASE_HEADERS); res.end('not found'); return; }
  if (info.isDirectory()) {
    if (item.scope !== 'tree') { res.writeHead(403, BASE_HEADERS); res.end('denied'); return; }
    if (rel !== '' && !rel.endsWith('/')) {
      res.writeHead(301, { ...BASE_HEADERS, Location: `${req.url!.split('?')[0]}/` });
      res.end();
      return;
    }
    const index = await resolveForItem(item, `${rel}index.html`);
    if (index.ok) { await serveFile(req, res, index.path); return; }
    const listing = await listDirectory(item.root!, hit.path);
    const body = JSON.stringify(listing);
    res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
    return;
  }
  await serveFile(req, res, hit.path);
}
