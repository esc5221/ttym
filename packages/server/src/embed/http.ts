/**
 * The embed HTTP surface (docs/embedding.md):
 *
 *   POST   /api/embed/v1/grants                 consumer key → a grant for one person
 *   GET    /api/embed/v1/grant                  grant → what it reaches and until when
 *   DELETE /api/embed/v1/grants/:id             consumer key → end it, close its sockets
 *   GET    /api/embed/v1/workspaces/:ws/tabs            grant (terminal.read)
 *   POST   /api/embed/v1/workspaces/:ws/tabs            grant (tabs.write) — the registered profile's command
 *   PATCH  /api/embed/v1/workspaces/:ws/tabs/:sid       grant (tabs.write) — rename
 *   DELETE /api/embed/v1/workspaces/:ws/tabs/:sid       grant (tabs.write) — close, shell ends
 *   GET    /embed/v1/…                          the panel and sdk.js, from the web build
 *
 * These paths skip the remote gate (remote/http.ts): a consumer's proxy forwards
 * them with its own Host and Origin, and the key or grant here is the check.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { checkGrantRequest, type EmbedAccess, type EmbedCap, type EmbedTab, type SpawnProfile } from '@ttym/protocol';
import type { ConsumerStore, Grant, GrantStore } from './store.js';
import type { SessionManager } from '../session-manager.js';
import type { WorkspaceStore } from '../workspace-store.js';

export const EMBED_API_PREFIX = '/api/embed/v1/';
export const EMBED_PAGE_PREFIX = '/embed/v1/';
export const EMBED_WS_PATH = '/embed/v1/ws';

/** Paths the remote gate leaves to this module. */
export function isEmbedPath(path: string): boolean {
  return path.startsWith(EMBED_API_PREFIX) || path.startsWith(EMBED_PAGE_PREFIX) || path === '/embed/v1';
}

export interface EmbedDeps {
  consumers: ConsumerStore;
  grants: GrantStore;
  manager: SessionManager;
  workspaces: WorkspaceStore;
  /** packages/web/dist — the panel lives under embed/v1/, fonts at the root. */
  webDist: string;
  log: (...a: unknown[]) => void;
}

const TAB_NAME_RE = /^[^\s:/#%]{1,32}$/;
const DEFAULT_TAB_NAME = 'sh';

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) { super(message); }
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = h.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1]! : null;
}

function readBody(req: IncomingMessage, limit = 16 * 1024): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > limit) { reject(new HttpError(413, 'body too large')); req.destroy(); } });
    req.on('end', () => resolveBody(body));
    req.on('error', reject);
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(req);
  if (!body.trim()) return {};
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}
  throw new HttpError(400, 'body must be a JSON object');
}

/**
 * Origin is a second check, not identity — the grant is that. Browsers always send
 * Origin on a WebSocket and on non-GET fetches, so there it must be present and
 * registered. A same-origin GET carries none; the grant alone answers it.
 */
export function originOk(origin: string | undefined, method: string | undefined, allowed: readonly string[]): boolean {
  if (origin === undefined) return method === 'GET' || method === 'HEAD';
  return allowed.includes(origin);
}

export function workspaceOfFn(workspaces: WorkspaceStore): (sid: number) => string | undefined {
  return (sid) => {
    for (const ws of workspaces.list()) if (ws.members.some((m) => m.sessionId === sid)) return ws.id;
    return undefined;
  };
}

// ── static ──

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png', '.map': 'application/json; charset=utf-8',
};

function serveEmbedStatic(req: IncomingMessage, res: ServerResponse, path: string, deps: EmbedDeps): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  if (path === '/embed/v1') { res.writeHead(301, { Location: 'v1/' }); res.end(); return; }
  const rest = path.slice(EMBED_PAGE_PREFIX.length);
  // resolve() restarts at an absolute segment: `/embed/v1//etc/hosts` would read /etc/hosts.
  // So: a relative path only, and the result must stay under the directory it was joined to.
  if (rest.startsWith('/') || rest.includes('\\') || rest.includes('..') || rest.includes('\0')) { res.writeHead(400); res.end('invalid path'); return; }
  // Fonts are the main app's (packages/web/public); the panel asks for them relative to itself.
  const fromRoot = rest.startsWith('fonts/') || rest === 'ttym-glyphs.woff2';
  const root = fromRoot ? resolve(deps.webDist) : resolve(deps.webDist, 'embed/v1');
  const file = rest === '' ? resolve(root, 'index.html') : resolve(root, rest);
  if (!file.startsWith(root + sep) || !(extname(file) in MIME)) { res.writeHead(404); res.end('not found'); return; }
  const origins = deps.consumers.allOrigins();
  void readFile(file).then((body) => {
    const isHtml = file.endsWith('.html');
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': file.includes('/assets/') ? 'public, max-age=31536000, immutable' : isHtml ? 'no-cache' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...(isHtml ? { 'Content-Security-Policy': `frame-ancestors ${origins.length ? origins.join(' ') : "'none'"}` } : {}),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }, () => {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(rest === '' || rest === 'index.html' ? 'embed panel not built: run `pnpm --dir packages/web build`' : 'not found');
  });
}

// ── tabs ──

const serialQueues = new Map<string, Promise<unknown>>();
/** One mutation at a time per workspace: two browsers must not each create "the first" tab. */
function serial<T>(wsId: string, fn: () => Promise<T>): Promise<T> {
  const prev = serialQueues.get(wsId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  serialQueues.set(wsId, run.catch(() => {}));
  return run;
}

function freeName(taken: Set<string>, base: string): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

function tabsOf(deps: EmbedDeps, wsId: string): EmbedTab[] {
  const ws = deps.workspaces.get(wsId);
  if (!ws) return [];
  return ws.members.map((m) => {
    const s = deps.manager.get(m.sessionId);
    return { sid: m.sessionId, name: m.name, status: !s ? 'gone' : s.isDead ? 'exited' : 'running', createdAt: m.createdAt };
  });
}

/** A shell that exited closes its tab, as in any terminal app. */
function prune(deps: EmbedDeps, wsId: string): void {
  for (const tab of tabsOf(deps, wsId)) {
    if (tab.status === 'running') continue;
    deps.workspaces.removeMember(wsId, tab.sid);
    if (deps.manager.get(tab.sid)) deps.manager.destroy(tab.sid);
  }
}

async function createTab(deps: EmbedDeps, wsId: string, profile: SpawnProfile, name: string | undefined): Promise<EmbedTab> {
  const ws = deps.workspaces.get(wsId);
  const members = ws?.members ?? [];
  if (members.length >= profile.maxTabs) throw new HttpError(409, `at most ${profile.maxTabs} tabs`, 'tab_limit');
  const taken = new Set(members.map((m) => m.name));
  let tabName: string;
  if (name === undefined) tabName = freeName(taken, DEFAULT_TAB_NAME);
  else {
    tabName = name.trim();
    if (!TAB_NAME_RE.test(tabName)) throw new HttpError(400, 'tab name: 1–32 characters, no spaces or : / # %');
    if (taken.has(tabName)) throw new HttpError(409, `tab "${tabName}" already exists`, 'member_name_taken');
  }
  const session = await deps.manager.create(profile.cmd, 120, 40, profile.cwd);
  try {
    if (ws) deps.workspaces.addMember(wsId, { sessionId: session.id, name: tabName, tags: [] });
    else {
      const now = Date.now();
      deps.workspaces.create(wsId, wsId, { type: 'pane', sessionId: session.id }, [{ sessionId: session.id, name: tabName, tags: [], createdAt: now, updatedAt: now }]);
    }
  } catch (e) {
    deps.manager.destroy(session.id);
    throw new HttpError(409, (e as Error).message, 'conflict');
  }
  const tab = tabsOf(deps, wsId).find((t) => t.sid === session.id);
  return tab ?? { sid: session.id, name: tabName, status: 'running', createdAt: Date.now() };
}

/** The tab list a client sees: dead ones pruned, and — for a keepOne profile — never empty. */
async function listTabs(deps: EmbedDeps, wsId: string, profile: SpawnProfile | undefined): Promise<EmbedTab[]> {
  prune(deps, wsId);
  let tabs = tabsOf(deps, wsId);
  if (tabs.length === 0 && profile?.keepOne) {
    await createTab(deps, wsId, profile, undefined);
    tabs = tabsOf(deps, wsId);
  }
  return tabs;
}

/** The caller's capabilities on one workspace, and the profile a tabs.write entry named. */
function onWorkspace(access: readonly EmbedAccess[], wsId: string): { caps: Set<EmbedCap>; profile?: string } {
  const caps = new Set<EmbedCap>();
  let profile: string | undefined;
  for (const a of access) {
    if (!('workspace' in a) || a.workspace !== wsId) continue;
    for (const c of a.caps) caps.add(c);
    if (a.profile) profile ??= a.profile;
  }
  return { caps, profile };
}

// ── routing ──

/** True when the request was an embed path (answered here, one way or another). */
export function handleEmbedHttp(req: IncomingMessage, res: ServerResponse, deps: EmbedDeps): boolean {
  const url = new URL(req.url || '/', 'http://x');
  const path = url.pathname;
  if (!isEmbedPath(path)) return false;
  if (!path.startsWith(EMBED_API_PREFIX)) { serveEmbedStatic(req, res, path, deps); return true; }

  const json = (status: number, body: unknown) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'Cache-Control': 'no-store', Connection: 'close' });
    res.end(payload);
  };
  route(req, path, deps).then(([status, body]) => json(status, body), (e) => {
    if (e instanceof HttpError) json(e.status, { error: e.message, ...(e.code ? { code: e.code } : {}) });
    else { deps.log('EMBED error', e); json(500, { error: 'internal error' }); }
  });
  return true;
}

async function route(req: IncomingMessage, path: string, deps: EmbedDeps): Promise<[number, unknown]> {
  const rest = path.slice(EMBED_API_PREFIX.length);

  // ── consumer-authenticated: mint and revoke ──
  if (rest === 'grants' || rest.startsWith('grants/')) {
    const key = bearer(req);
    const who = key ? deps.consumers.byKey(key) : null;
    if (!who) throw new HttpError(401, 'consumer key required (Authorization: Bearer <key>)', 'consumer_key');
    if (rest === 'grants' && req.method === 'POST') {
      const body = await readJson(req);
      const workspaceOf = workspaceOfFn(deps.workspaces);
      const checked = checkGrantRequest(who.consumer, body, workspaceOf);
      if (!checked.ok) throw new HttpError(400, checked.error, 'outside_registration');
      const { token, grant } = deps.grants.mint(who.id, who.consumer, checked.access, checked.ttlMs, checked.subject);
      deps.log(`EMBED grant id=${grant.id} consumer=${who.id} subject=${grant.subject || '-'} ttl=${Math.round(checked.ttlMs / 1000)}s access=${describe(grant.access)}`);
      return [201, { grant: token, id: grant.id, expiresAt: grant.expiresAt, access: grant.access }];
    }
    const m = rest.match(/^grants\/([A-Za-z0-9_-]+)$/);
    if (m && req.method === 'DELETE') {
      const grant = deps.grants.get(m[1]!);
      if (!grant || grant.consumerId !== who.id) throw new HttpError(404, 'no such grant');
      deps.grants.revoke(grant.id);
      deps.log(`EMBED revoke id=${grant.id} consumer=${who.id}`);
      return [200, { ok: true }];
    }
    throw new HttpError(404, 'not found');
  }

  // ── grant-authenticated ──
  const tabs = rest.match(/^workspaces\/([^/]+)\/tabs(?:\/(\d+))?$/);
  if (!tabs && rest !== 'grant') throw new HttpError(404, 'not found');
  const grant = deps.grants.lookup(bearer(req));
  if (!grant) throw new HttpError(401, 'grant missing, expired or revoked', 'grant');
  const consumer = deps.consumers.get(grant.consumerId)!;
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  if (!originOk(origin, req.method, consumer.origins)) throw new HttpError(403, 'origin not registered for this consumer', 'origin');
  // What this grant reaches — the panel reads it when only a grant was handed to it.
  if (rest === 'grant') {
    if (req.method !== 'GET') throw new HttpError(405, 'method not allowed');
    return [200, { id: grant.id, expiresAt: grant.expiresAt, access: grant.access }];
  }
  if (!tabs) throw new HttpError(404, 'not found');
  const wsId = decodeURIComponent(tabs[1]!);
  const sid = tabs[2] ? parseInt(tabs[2], 10) : undefined;
  const { caps, profile: profileName } = onWorkspace(grant.access, wsId);
  if (!caps.has('terminal.read')) throw new HttpError(403, 'this grant does not reach that workspace', 'scope');
  const profile = profileName ? consumer.profiles[profileName] : undefined;

  if (req.method === 'GET' && sid === undefined) {
    return [200, { tabs: await serial(wsId, () => listTabs(deps, wsId, caps.has('tabs.write') ? profile : undefined)) }];
  }
  if (!caps.has('tabs.write') || !profile) throw new HttpError(403, 'this grant cannot change tabs', 'scope');

  if (req.method === 'POST' && sid === undefined) {
    const body = await readJson(req);
    if (body.name !== undefined && typeof body.name !== 'string') throw new HttpError(400, 'name must be a string');
    return [201, await serial(wsId, async () => {
      prune(deps, wsId);
      const tab = await createTab(deps, wsId, profile, (body.name as string | undefined) || undefined);
      deps.log(`EMBED tab-create grant=${grant.id} consumer=${grant.consumerId} subject=${grant.subject || '-'} ws=${wsId} sid=${tab.sid}`);
      return { tab, tabs: tabsOf(deps, wsId) };
    })];
  }
  if (sid === undefined) throw new HttpError(405, 'method not allowed');
  const member = () => deps.workspaces.get(wsId)?.members.find((m) => m.sessionId === sid);

  if (req.method === 'PATCH') {
    const body = await readJson(req);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!TAB_NAME_RE.test(name)) throw new HttpError(400, 'tab name: 1–32 characters, no spaces or : / # %');
    return [200, { tabs: await serial(wsId, async () => {
      if (!member()) throw new HttpError(404, 'no such tab');
      try { deps.workspaces.renameMember(wsId, sid, name); } catch (e) { throw new HttpError(409, (e as Error).message, 'member_name_taken'); }
      return listTabs(deps, wsId, profile);
    }) }];
  }
  if (req.method === 'DELETE') {
    return [200, { tabs: await serial(wsId, async () => {
      // Only this workspace's members — not a generic "kill any session".
      if (!member()) throw new HttpError(404, 'no such tab');
      deps.workspaces.removeMember(wsId, sid);
      deps.manager.destroy(sid);
      deps.log(`EMBED tab-close grant=${grant.id} consumer=${grant.consumerId} subject=${grant.subject || '-'} ws=${wsId} sid=${sid}`);
      return listTabs(deps, wsId, profile);
    }) }];
  }
  throw new HttpError(405, 'method not allowed');
}

function describe(access: readonly EmbedAccess[]): string {
  return access.map((a) => ('workspace' in a ? `ws:${a.workspace}` : `%${a.session}`) + '[' + a.caps.join(',') + ']').join(' ');
}

export type { Grant };
