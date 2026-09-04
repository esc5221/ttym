/**
 * HTTP adapter for the viewer. Two surfaces, kept apart on purpose:
 *
 *   control  /api/sessions/:sid/views…   JSON, mutates, pushed as CMD.VIEW
 *   content  /view/<cap>/<rel>           GET/HEAD bytes, read-only CORS, nosniff
 *
 * The split lets an <iframe> resolve `./style.css` under a trailing-slash
 * prefix, and keeps the content surface's headers (read-only CORS,
 * nosniff, Range) apart from the API's.
 * Note `/view` is a route, not an origin — a sandboxed frame with
 * allow-same-origin would still be us. The web app never grants that to a
 * local file.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ViewPresentation } from '@ttym/protocol';
import { toPublicState, type ViewerStore } from './store.js';
import type { ViewerService } from './service.js';
import { serveContent, PREFLIGHT_HEADERS } from './content.js';

const BODY_MAX_BYTES = 64 * 1024;

export interface ViewerHttpDeps {
  store: ViewerStore;
  service: ViewerService;
  sessionExists: (sessionId: number) => boolean;
  json: (status: number, body: unknown) => void;
  readBody: () => Promise<string>;
  log?: (...args: unknown[]) => void;
}

/** Control surface. Returns true when the request was one of ours. */
export function handleViewerApi(req: IncomingMessage, path: string, deps: ViewerHttpDeps): boolean {
  const m = path.match(/^\/api\/sessions\/(\d+)\/views(?:\/([A-Za-z0-9]+))?$/);
  if (!m) return false;
  const sessionId = parseInt(m[1]!, 10);
  const itemId = m[2];
  const { store, service, json } = deps;

  if (!deps.sessionExists(sessionId)) { json(404, { error: 'not found' }); return true; }

  if (!itemId && req.method === 'GET') {
    const state = store.get(sessionId);
    json(200, state ? toPublicState(state) : null);
    return true;
  }

  if (!itemId && req.method === 'POST') {
    deps.readBody().then(async (body) => {
      if (body.length > BODY_MAX_BYTES) { json(413, { error: 'body too large' }); return; }
      let parsed: { targets?: unknown; presentation?: unknown; root?: unknown };
      try { parsed = JSON.parse(body); } catch { json(400, { error: 'invalid body' }); return; }
      const targets = Array.isArray(parsed.targets) ? parsed.targets.filter((t): t is string => typeof t === 'string') : [];
      if (targets.length === 0) { json(400, { error: 'targets required' }); return; }
      const presentation: ViewPresentation | undefined = parsed.presentation === 'full' ? 'full' : parsed.presentation === 'pane' ? 'pane' : undefined;
      const root = typeof parsed.root === 'string' && parsed.root.startsWith('/') ? parsed.root : undefined;
      const { state, results } = await service.open(sessionId, targets, { presentation, root });
      deps.log?.(`VIEW open session=${sessionId} ${results.map((r) => (r.ok ? `${r.id}:${r.rev}` : `!${r.error}`)).join(' ')}`);
      const anyOk = results.some((r) => r.ok);
      json(anyOk ? 200 : 404, { state: state ? toPublicState(state) : null, results });
    }).catch(() => json(500, { error: 'open failed' }));
    return true;
  }

  if (!itemId && req.method === 'DELETE') {
    service.closeAll(sessionId);
    json(200, { state: null });
    return true;
  }

  if (itemId && req.method === 'DELETE') {
    const before = store.get(sessionId);
    if (!before || !before.items.some((item) => item.id === itemId)) { json(404, { error: 'no such tab' }); return true; }
    const state = service.close(sessionId, itemId);
    json(200, { state: state ? toPublicState(state) : null });
    return true;
  }

  json(405, { error: 'method not allowed' });
  return true;
}

/** Content surface. Returns true when the request was one of ours. */
export function handleViewContent(req: IncomingMessage, res: ServerResponse, path: string, deps: Pick<ViewerHttpDeps, 'store'>): boolean {
  const m = path.match(/^\/view\/([a-f0-9]{32})(?:\/(.*))?$/);
  if (!m) return false;
  if (req.method === 'OPTIONS') { res.writeHead(204, PREFLIGHT_HEADERS); res.end(); return true; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return true; }
  const cap = m[1]!;
  const rel = m[2] ?? '';
  const hit = deps.store.byCap(cap);
  if (!hit) { res.writeHead(404, { 'Cache-Control': 'private, no-cache' }); res.end('not found'); return true; }
  let decoded: string;
  try { decoded = decodeURIComponent(rel); } catch { res.writeHead(400); res.end('bad path'); return true; }
  serveContent(req, res, hit.item, decoded).catch(() => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
  return true;
}
