import { createServer as createHttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { SessionManager } from './session-manager.js';
import { WorkspaceStore } from './workspace-store.js';
import { InteractionStore } from './interaction.js';
import { sweepRuntimeDir } from './run-gc.js';
import { CMD, encode, encodeData, encodeSnapshot, decodeClientFrame, toBuffer, jsonPayload, parseJson } from './protocol.js';
import { API_VERSION, isRuntimeMetaKey, runtimeMetaKeys, isRuntimeOnlyPatch } from '@ttym/protocol';

const DEFAULT_SHELL = process.env.SHELL || '/bin/bash';

const BATCH_MS = 4;
const MAX_BATCH_BYTES = 64 * 1024;
const IMMEDIATE_THRESHOLD = 512; // bytes — flush immediately for interactive typing
const WS_HIGH_WATER = 1 << 20;
// Ack-based viewer backpressure (vscode terminal model): measure what the
// client has *parsed*, not what the network delivered. Wide hysteresis keeps
// the stream from stuttering at the boundary.
const ACK_HIGH_WATER = 256 * 1024;
const ACK_LOW_WATER = 16 * 1024;
const WS_LOW_WATER = 1 << 18;

const DEBUG = true;
const log = (...args: unknown[]) => DEBUG && console.log(`[srv ${new Date().toISOString().slice(11, 23)}]`, ...args);

const SERVER_DIR = fileURLToPath(new URL('.', import.meta.url));
// Works both from source (packages/server/src/) and bundle (dist/)
const DEMO_DIST_DIR = (() => {
  const fromSource = resolve(SERVER_DIR, '../../web/dist');
  const fromBundle = resolve(SERVER_DIR, '../packages/web/dist');
  try { require('fs').statSync(fromSource); return fromSource; } catch {}
  return fromBundle;
})();

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function safeSend(ws: WebSocket, data: Uint8Array): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  try { ws.send(data); return true; } catch { return false; }
}

function isSafeAssetPath(pathname: string): boolean {
  return !pathname.includes('..');
}

async function serveStaticFile(res: ServerResponse, filePath: string): Promise<boolean> {
  try {
    const body = await readFile(filePath);
    const contentType = MIME_TYPES[extname(filePath)] ?? 'application/octet-stream';
    res.writeHead(200, {
      'Cache-Control': 'public, max-age=300',
      'Content-Type': contentType,
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

function handleDemoApp(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const path = decodeURIComponent(url.pathname);

  if (path.startsWith('/api/') || path === '/api' || path === '/ws') return false;
  if (!isSafeAssetPath(path)) {
    res.writeHead(400);
    res.end('invalid path');
    return true;
  }

  void (async () => {
    const assetPath = path === '/' ? '/index.html' : path;
    const requestedFile = resolve(DEMO_DIST_DIR, `.${assetPath}`);

    if (extname(assetPath)) {
      if (await serveStaticFile(res, requestedFile)) return;
      res.writeHead(404);
      res.end('not found');
      return;
    }

    if (await serveStaticFile(res, requestedFile)) return;

    const served = await serveStaticFile(res, resolve(DEMO_DIST_DIR, 'index.html'));
    if (!served) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('demo build not found: run `pnpm --dir packages/web build`');
    }
  })().catch((error) => {
    console.error('Static serve error:', error);
    if (!res.headersSent) res.writeHead(500);
    res.end('internal error');
  });

  return true;
}

interface SessionBatch {
  seq: number;
  data: Buffer;
}

interface SessionBatcher {
  pending: SessionBatch[];
  pendingBytes: number;
  timer: NodeJS.Timeout | null;
  pausedForBackpressure: boolean;
  drainTimer: NodeJS.Timeout | null;
  pausedView: boolean;
  /** Client has acked at least once — enables ack accounting; without it we
   *  fall back to bufferedAmount so a non-acking consumer is never frozen. */
  acking: boolean;
  sentEntries: Array<{ seq: number; bytes: number }>;
  unackedBytes: number;
  lastSentSeq: number;
}

// ───── ACK 추적 (viewer별) ─────
// viewerId → { sessionId → lastAckSeq }
const viewerAcks = new Map<string, Map<number, number>>();

function updateViewerAck(viewerId: string, sessionId: number, seq: number) {
  let m = viewerAcks.get(viewerId);
  if (!m) { m = new Map(); viewerAcks.set(viewerId, m); }
  m.set(sessionId, seq);
}

function removeViewerAcks(viewerId: string) {
  viewerAcks.delete(viewerId);
}

/** 모든 viewer의 ACK 중 최소값 기준으로 ring trim */
function minAckTrim(manager: SessionManager, sessionId: number) {
  let minAck = Infinity;
  for (const [, m] of viewerAcks) {
    const ack = m.get(sessionId);
    if (ack !== undefined && ack < minAck) minAck = ack;
  }
  if (minAck < Infinity) {
    manager.get(sessionId)?.ring.trimTo(minAck);
  }
}

export interface TtymServer {
  manager: SessionManager;
  agentBus: unknown | null;
  wss: WebSocketServer;
  httpServer: ReturnType<typeof createHttpServer>;
  close: () => Promise<void>;
}

// ───── HTTP API ─────

function handleHttpApi(manager: SessionManager, workspaceStore: WorkspaceStore, interactions: InteractionStore, req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }

  const json = (status: number, body: unknown) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'Connection': 'close',
    });
    res.end(payload);
  };

  const readBody = (): Promise<string> => new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => resolve(body));
  });

  // GET /api/version — lets a client refuse an incompatible server
  if (path === '/api/version' && req.method === 'GET') {
    json(200, { apiVersion: API_VERSION, role: 'ttym-server' });
    return true;
  }

  // GET /api/sessions
  if (path === '/api/sessions' && req.method === 'GET') {
    json(200, manager.list());
    return true;
  }

  // POST /api/sessions — create
  if (path === '/api/sessions' && req.method === 'POST') {
    readBody().then(async (body) => {
      try {
        const opts = body ? JSON.parse(body) : {};
        const cmd = Array.isArray(opts.cmd) ? opts.cmd : [DEFAULT_SHELL];
        const cols = opts.cols || 80;
        const rows = opts.rows || 24;
        const cwd = typeof opts.cwd === 'string' && opts.cwd.trim() ? opts.cwd : undefined;
        const verify = opts.verify === true;
        const session = await manager.create(cmd, cols, rows, cwd);
        log(`HTTP CREATE session=${session.id} pid=${session.pid} verify=${verify}`);

        if (verify) {
          // Wait up to 2s to detect early PTY exit (invalid command)
          const earlyExit = await new Promise<boolean>((resolve) => {
            if (session.isDead) { resolve(true); return; }
            const timer = setTimeout(() => resolve(false), 2000);
            session.onExit(() => {
              clearTimeout(timer);
              resolve(true);
            });
          });

          if (earlyExit) {
            log(`HTTP CREATE session=${session.id} early exit detected, cleaning up`);
            manager.destroy(session.id);
            json(422, { error: 'command exited immediately', sessionId: session.id });
            return;
          }
        }

        json(201, session.info());
      } catch (e) {
        console.error('HTTP CREATE error:', e);
        json(500, { error: String(e) });
      }
    });
    return true;
  }

  // GET /api/sessions/:id
  const sessionMatch = path.match(/^\/api\/sessions\/(\d+)$/);
  if (sessionMatch) {
    const id = parseInt(sessionMatch[1], 10);
    const session = manager.get(id);

    if (req.method === 'GET') {
      if (!session || session.isDead) { json(404, { error: 'not found' }); return true; }
      json(200, session.info());
      return true;
    }

    // DELETE /api/sessions/:id
    if (req.method === 'DELETE') {
      manager.destroy(id);
      log(`HTTP DESTROY session=${id}`);
      json(200, { ok: true });
      return true;
    }
  }

  // POST /api/sessions/:id/send — send keys
  // POST /api/sessions/:id/interactions — submit a prompt, wait for the answer
  const interactionsMatch = path.match(/^\/api\/sessions\/(\d+)\/interactions$/);
  if (interactionsMatch && req.method === 'POST') {
    const id = parseInt(interactionsMatch[1], 10);
    readBody().then(async (body) => {
      const session = manager.get(id);
      if (!session || session.isDead) { json(404, { error: 'not found' }); return; }
      let prompt: string;
      let timeoutMs = 120_000;
      let submit: string = 'cr';
      try {
        const parsed = JSON.parse(body);
        prompt = parsed.prompt;
        if (typeof prompt !== 'string') { json(400, { error: 'prompt must be string' }); return; }
        if (typeof parsed.timeoutMs === 'number') timeoutMs = parsed.timeoutMs;
        if (typeof parsed.submit === 'string') submit = parsed.submit;
      } catch {
        json(400, { error: 'invalid body' }); return;
      }

      // Mark before writing: output that arrives between the two would
      // otherwise fall outside the range and be dropped from the transcript.
      const interaction = interactions.start(session, prompt);
      // A PTY that exits mid-answer will never report Stop; settle the wait
      // rather than hold the request open until its timeout.
      session.onExit(() => interactions.abandonSession(id));
      session.write(Buffer.from(prompt));
      // Interactive TUIs read Enter as CR; a shell wants LF. Neither is right
      // for both, so the caller says which, defaulting to the agent case.
      if (submit === 'cr') session.write(Buffer.from([0x0d]));
      else if (submit === 'lf') session.write(Buffer.from([0x0a]));
      log(`HTTP INTERACTION session=${id} id=${interaction.id} len=${prompt.length}`);

      const settled = await interactions.wait(interaction.id, timeoutMs);
      if (settled && settled.status !== 'pending') { json(200, { interaction: settled }); return; }
      // Still running. Hand back a handle instead of a wrong answer.
      res.setHeader('Location', `/api/sessions/${id}/interactions/${interaction.id}`);
      json(202, { interaction: settled ?? interaction });
    });
    return true;
  }

  // GET /api/sessions/:id/interactions/:iid — resume waiting on a 202
  const interactionGet = path.match(/^\/api\/sessions\/(\d+)\/interactions\/([A-Za-z0-9_]+)$/);
  if (interactionGet && req.method === 'GET') {
    const iid = interactionGet[2];
    const waitMs = parseInt(url.searchParams.get('wait') || '0', 10) || 0;
    const existing = interactions.get(iid);
    if (!existing) { json(404, { error: 'not found' }); return true; }
    if (existing.status !== 'pending' || waitMs <= 0) { json(200, { interaction: existing }); return true; }
    interactions.wait(iid, waitMs).then((settled) => {
      const current = settled ?? existing;
      if (current.status !== 'pending') { json(200, { interaction: current }); return; }
      res.setHeader('Location', path);
      json(202, { interaction: current });
    });
    return true;
  }

  // POST /api/internal/sessions/:id/agent — agent-state writes from hooks.
  // Accepts only runtime keys; everything else belongs on the public meta.
  const agentMetaMatch = path.match(/^\/api\/internal\/sessions\/(\d+)\/agent$/);
  if (agentMetaMatch && req.method === 'POST') {
    const id = parseInt(agentMetaMatch[1], 10);
    readBody().then(async (body) => {
      try {
        const patch = JSON.parse(body);
        if (typeof patch !== 'object' || patch === null || !isRuntimeOnlyPatch(patch)) {
          json(400, { error: 'body must be an object of runtime keys only' });
          return;
        }
        const merged = await manager.setMeta(id, patch);
        log(`AGENT META session=${id} keys=${Object.keys(patch).join(',')}`);
        json(200, merged);
      } catch {
        json(400, { error: 'invalid body' });
      }
    });
    return true;
  }

  // POST /api/internal/sessions/:id/stop — agent hook entry point
  const stopMatch = path.match(/^\/api\/internal\/sessions\/(\d+)\/stop$/);
  if (stopMatch && req.method === 'POST') {
    const id = parseInt(stopMatch[1], 10);
    readBody().then((body) => {
      const session = manager.get(id);
      if (!session) { json(404, { error: 'not found' }); return; }
      // Claude reports Stop, StopFailure and SessionEnd; only the first means
      // the agent answered. The rest still end the wait — an agent that died
      // is not going to reply, and blocking to timeout would misreport that.
      let outcome: 'completed' | 'failed' = 'completed';
      try {
        const parsed = body ? JSON.parse(body) : {};
        if (parsed.event === 'StopFailure' || parsed.event === 'SessionEnd') outcome = 'failed';
        if (parsed.outcome === 'failed') outcome = 'failed';
      } catch { /* an empty or malformed body is treated as a plain Stop */ }
      const settled = interactions.finish(session, outcome);
      log(`HTTP STOP session=${id} outcome=${outcome} interaction=${settled?.id ?? 'none'}`);
      json(200, { ok: true, interaction: settled });
    });
    return true;
  }

  const sendMatch = path.match(/^\/api\/sessions\/(\d+)\/send$/);
  if (sendMatch && req.method === 'POST') {
    const id = parseInt(sendMatch[1], 10);
    readBody().then((body) => {
      const session = manager.get(id);
      if (!session || session.isDead) { json(404, { error: 'not found' }); return; }
      try {
        const { data } = JSON.parse(body);
        if (typeof data !== 'string') { json(400, { error: 'data must be string' }); return; }
        session.write(Buffer.from(data));
        log(`HTTP SEND session=${id} len=${data.length}`);
        json(200, { ok: true });
      } catch {
        json(400, { error: 'invalid body' });
      }
    });
    return true;
  }

  // GET /api/sessions/:id/screen — read current screen
  const screenMatch = path.match(/^\/api\/sessions\/(\d+)\/screen$/);
  if (screenMatch && req.method === 'GET') {
    const id = parseInt(screenMatch[1], 10);
    const session = manager.get(id);
    if (!session || session.isDead) { json(404, { error: 'not found' }); return true; }
    json(200, { screen: session.snapshot() });
    return true;
  }

  // GET /api/sessions/:id/runtime — the server-owned view, assembled rather
  // than stored: terminal geometry from the session, process state from the
  // holder, the agent mapping from runtime meta, and the in-flight interaction.
  const runtimeMatch = path.match(/^\/api\/sessions\/(\d+)\/runtime$/);
  if (runtimeMatch && req.method === 'GET') {
    const id = parseInt(runtimeMatch[1], 10);
    const session = manager.get(id);
    if (!session) { json(404, { error: 'not found' }); return true; }
    manager.getMeta(id).then((meta) => {
      const agentKind = meta.claudeSessionId || meta.claudeLastSessionId
        ? 'claude-code'
        : meta.codexSessionId || meta.codexLastSessionId ? 'codex' : null;
      json(200, {
        terminal: {
          cols: session.cols,
          rows: session.rows,
          lastSeq: session.ring.nextSeq - 1,
          appliedOffset: session.appliedOffset,
          generation: session.generation,
          recoveryGap: session.recoveryGap,
        },
        process: {
          pid: session.childPid,
          state: session.isDead ? (session.evicted ? 'evicted' : 'dead') : 'running',
          exitCode: session.exitCode,
        },
        agent: {
          kind: agentKind,
          externalSessionId: meta.claudeSessionId ?? meta.codexSessionId ?? null,
          active: meta.claudeActive === true || meta.codexActive === true,
          activeInteractionId: interactions.pending(id)?.id ?? null,
        },
      });
    });
    return true;
  }

  // GET|PATCH /api/sessions/:id/annotations — the user-owned half of meta.
  // Same store underneath; the split is in what each surface will accept.
  const annotationsMatch = path.match(/^\/api\/sessions\/(\d+)\/annotations$/);
  if (annotationsMatch) {
    const id = parseInt(annotationsMatch[1], 10);
    if (!manager.get(id)) { json(404, { error: 'not found' }); return true; }

    if (req.method === 'GET') {
      manager.getMeta(id).then((meta) => {
        const annotations: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(meta)) {
          if (!isRuntimeMetaKey(key)) annotations[key] = value;
        }
        json(200, annotations);
      });
      return true;
    }

    if (req.method === 'PATCH') {
      readBody().then(async (body) => {
        try {
          const patch = JSON.parse(body);
          if (typeof patch !== 'object' || patch === null) { json(400, { error: 'body must be object' }); return; }
          const owned = runtimeMetaKeys(patch);
          if (owned.length > 0) {
            json(400, { error: `runtime keys are server-owned: ${owned.join(', ')}` });
            return;
          }
          const merged = await manager.setMeta(id, patch);
          const annotations: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(merged)) {
            if (!isRuntimeMetaKey(key)) annotations[key] = value;
          }
          json(200, annotations);
        } catch {
          json(400, { error: 'invalid body' });
        }
      });
      return true;
    }
  }

  // GET /api/sessions/:id/meta
  const metaMatch = path.match(/^\/api\/sessions\/(\d+)\/meta$/);
  if (metaMatch) {
    const id = parseInt(metaMatch[1], 10);

    if (req.method === 'GET') {
      manager.getMeta(id).then((meta) => json(200, meta));
      return true;
    }

    // PATCH /api/sessions/:id/meta — merge key-value pairs
    if (req.method === 'PATCH') {
      readBody().then(async (body) => {
        try {
          const patch = JSON.parse(body);
          if (typeof patch !== 'object' || patch === null) { json(400, { error: 'body must be object' }); return; }
          // Protocol and agent state is server-owned. Writing it through the
          // public surface is how an await used to be stalled from outside;
          // hooks go through the internal agent endpoint instead.
          const owned = runtimeMetaKeys(patch);
          if (owned.length > 0) {
            log(`META session=${id} rejected runtime keys=${owned.join(',')}`);
            json(400, { error: `runtime keys are server-owned: ${owned.join(', ')}` });
            return;
          }
          const merged = await manager.setMeta(id, patch);
          log(`META session=${id} keys=${Object.keys(patch).join(',')}`);
          json(200, merged);
        } catch {
          json(400, { error: 'invalid body' });
        }
      });
      return true;
    }
  }

  // POST /api/sessions/:id/resize
  const resizeMatch = path.match(/^\/api\/sessions\/(\d+)\/resize$/);
  if (resizeMatch && req.method === 'POST') {
    const id = parseInt(resizeMatch[1], 10);
    readBody().then((body) => {
      const session = manager.get(id);
      if (!session || session.isDead) { json(404, { error: 'not found' }); return; }
      try {
        const { cols, rows } = JSON.parse(body);
        if (cols > 0 && rows > 0) session.resize(cols, rows);
        json(200, { ok: true });
      } catch {
        json(400, { error: 'invalid body' });
      }
    });
    return true;
  }

  // ───── Workspace API ─────

  // GET /api/projects
  if (path === '/api/projects' && req.method === 'GET') {
    json(200, workspaceStore.listProjects());
    return true;
  }

  // GET /api/workspaces
  if (path === '/api/workspaces' && req.method === 'GET') {
    const project = url.searchParams.get('project');
    json(200, project ? workspaceStore.list().filter((workspace) => workspace.project === project) : workspaceStore.list());
    return true;
  }

  // POST /api/workspaces
  if (path === '/api/workspaces' && req.method === 'POST') {
    readBody().then((body) => {
      try {
        const { id, project, name, layout, members } = JSON.parse(body);
        if (!id || !name || !layout) { json(400, { error: 'id, name, layout required' }); return; }
        const ws = workspaceStore.create(id, name, layout, project || 'default', members || []);
        log(`WORKSPACE CREATE id=${id} project=${ws.project} name=${name}`);
        json(201, ws);
      } catch {
        json(400, { error: 'invalid body' });
      }
    });
    return true;
  }

  // PATCH /api/workspaces/:id
  const wsMatch = path.match(/^\/api\/workspaces\/([^/]+)$/);
  if (wsMatch) {
    const wsId = decodeURIComponent(wsMatch[1]);

    if (req.method === 'GET') {
      const ws = workspaceStore.get(wsId);
      if (!ws) { json(404, { error: 'not found' }); return true; }
      json(200, ws);
      return true;
    }

    if (req.method === 'PATCH') {
      readBody().then((body) => {
        try {
          const patch = JSON.parse(body);
          const ws = workspaceStore.update(wsId, patch);
          if (!ws) { json(404, { error: 'not found' }); return; }
          log(`WORKSPACE UPDATE id=${wsId}`);
          json(200, ws);
        } catch {
          json(400, { error: 'invalid body' });
        }
      });
      return true;
    }

    if (req.method === 'DELETE') {
      const deleted = workspaceStore.delete(wsId);
      log(`WORKSPACE DELETE id=${wsId} found=${deleted}`);
      json(200, { ok: true });
      return true;
    }
  }

  const memberMatch = path.match(/^\/api\/workspaces\/([^/]+)\/members\/(\d+)$/);
  if (memberMatch) {
    const wsId = decodeURIComponent(memberMatch[1]);
    const sessionId = parseInt(memberMatch[2], 10);

    if (req.method === 'PATCH') {
      readBody().then((body) => {
        try {
          const { name } = JSON.parse(body);
          if (!name || typeof name !== 'string') { json(400, { error: 'name required' }); return; }
          const ws = workspaceStore.renameMember(wsId, sessionId, name);
          if (!ws) { json(404, { error: 'not found' }); return; }
          log(`WORKSPACE MEMBER RENAME id=${wsId} session=${sessionId} name=${name}`);
          json(200, ws);
        } catch (error) {
          json(400, { error: error instanceof Error ? error.message : 'invalid body' });
        }
      });
      return true;
    }

    if (req.method === 'DELETE') {
      const ws = workspaceStore.removeMember(wsId, sessionId);
      if (!ws) { json(404, { error: 'not found' }); return true; }
      log(`WORKSPACE MEMBER REMOVE id=${wsId} session=${sessionId}`);
      json(200, ws);
      return true;
    }
  }

  const splitMatch = path.match(/^\/api\/workspaces\/([^/]+)\/split$/);
  if (splitMatch && req.method === 'POST') {
    const wsId = decodeURIComponent(splitMatch[1]);
    readBody().then(async (body) => {
      const workspace = workspaceStore.get(wsId);
      if (!workspace) { json(404, { error: 'not found' }); return; }
      try {
        const {
          targetSessionId,
          cmd,
          cols,
          rows,
          cwd,
          name,
          role,
          tags,
        } = JSON.parse(body || '{}');

        const targetId = Number.isInteger(targetSessionId) ? Number(targetSessionId) : undefined;
        let resolvedCwd: string | undefined;
        if (typeof cwd === 'string' && cwd.trim()) {
          resolvedCwd = cwd;
        } else if (targetId !== undefined) {
          const meta = await manager.getMeta(targetId);
          resolvedCwd = typeof meta.cwd === 'string' && meta.cwd.trim() ? meta.cwd : undefined;
        }

        const created = await manager.create(
          Array.isArray(cmd) && cmd.length > 0 ? cmd : [DEFAULT_SHELL],
          Number.isInteger(cols) && cols > 0 ? cols : 80,
          Number.isInteger(rows) && rows > 0 ? rows : 24,
          resolvedCwd,
        );

        try {
          const ws = workspaceStore.splitRight(wsId, targetId, {
            sessionId: created.id,
            name: typeof name === 'string' && name.trim() ? name : `term-${created.id}`,
            role: typeof role === 'string' ? role : undefined,
            tags: Array.isArray(tags) ? tags : [],
          });
          if (!ws) {
            manager.destroy(created.id);
            json(404, { error: 'not found' });
            return;
          }
          log(`WORKSPACE SPLIT id=${wsId} target=${targetId ?? 'none'} session=${created.id}`);
          json(201, { workspace: ws, session: created.info() });
        } catch (error) {
          manager.destroy(created.id);
          json(400, { error: error instanceof Error ? error.message : 'split failed' });
        }
      } catch (error) {
        json(400, { error: error instanceof Error ? error.message : 'invalid body' });
      }
    });
    return true;
  }

  const membersCollectionMatch = path.match(/^\/api\/workspaces\/([^/]+)\/members$/);
  if (membersCollectionMatch && req.method === 'POST') {
    const wsId = decodeURIComponent(membersCollectionMatch[1]);
    readBody().then((body) => {
      try {
        const { sessionId, name, role, tags } = JSON.parse(body);
        if (!sessionId || !name) { json(400, { error: 'sessionId and name required' }); return; }
        const ws = workspaceStore.addMember(wsId, {
          sessionId: Number(sessionId),
          name,
          role,
          tags: Array.isArray(tags) ? tags : [],
        });
        if (!ws) { json(404, { error: 'not found' }); return; }
        log(`WORKSPACE MEMBER ADD id=${wsId} session=${sessionId} name=${name}`);
        json(201, ws);
      } catch (error) {
        json(400, { error: error instanceof Error ? error.message : 'invalid body' });
      }
    });
    return true;
  }

  return false; // not handled
}

// ───── Main ─────

export async function createServer(port: number): Promise<TtymServer> {
  const manager = new SessionManager();

  // Load workspace store first so we know which session IDs deserve restore.
  // Sessions not referenced by any workspace remain on disk but stay dormant —
  // they can be revived later by adding them back to a workspace.
  const workspaceStore = new WorkspaceStore(manager.runtimeDir);
  await workspaceStore.load();
  const interactions = new InteractionStore();
  const restoreAllowlist = new Set<number>();
  for (const ws of workspaceStore.list()) {
    for (const m of ws.members) restoreAllowlist.add(m.sessionId);
  }

  await manager.boot(restoreAllowlist);

  // Sweep the accumulation of dead sessions' files. Live sessions and every
  // workspace member are always kept; the rest gets a two-week grace before
  // it goes. TTYM_GC_DAYS=0 turns this off.
  const gcDays = Number.parseInt(process.env.TTYM_GC_DAYS ?? '14', 10);
  let gcTimer: NodeJS.Timeout | null = null;
  if (gcDays > 0) {
    const sweep = () => {
      const keep = new Set<number>(restoreAllowlist);
      for (const info of manager.list()) keep.add(info.id);
      for (const ws of workspaceStore.list()) for (const m of ws.members) keep.add(m.sessionId);
      sweepRuntimeDir(manager.runtimeDir, keep, gcDays * 24 * 60 * 60 * 1000)
        .then(({ removed }) => {
          if (removed.length > 0) console.log(`[gc] swept ${removed.length} orphaned files`);
        })
        .catch(() => {});
    };
    sweep();
    gcTimer = setInterval(sweep, 24 * 60 * 60 * 1000);
    gcTimer.unref();
  }

  // Agent Bus is optional and currently disabled in the bundled server path.
  const agentBus = null as { close?: () => void } | null;
  const fileBridge = null as { stop?: () => void } | null;
  const handleAgentRequest = null as ((req: IncomingMessage, res: ServerResponse) => boolean) | null;

  // Inject TTYM_BUS_URL into SessionManager for holder env
  manager.setBusUrl(`http://127.0.0.1:${port}/api`);

  const httpServer = createHttpServer((req, res) => {
    if (handleAgentRequest && handleAgentRequest(req, res)) return;
    if (handleHttpApi(manager, workspaceStore, interactions, req, res)) return;
    if (handleDemoApp(req, res)) return;
    res.writeHead(404);
    res.end('not found');
  });
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws: WebSocket) => {
    const viewerId = randomUUID();
    const clientSessions = new Set<number>();
    const batchers = new Map<number, SessionBatcher>();
    const exitWired = new Set<number>(); // prevent duplicate onExit per session

    function getBatcher(sessionId: number): SessionBatcher {
      let batcher = batchers.get(sessionId);
      if (!batcher) {
        batcher = {
          pending: [],
          pendingBytes: 0,
          timer: null,
          pausedForBackpressure: false,
          drainTimer: null,
          pausedView: false,
          acking: false,
          sentEntries: [],
          unackedBytes: 0,
          lastSentSeq: 0,
        };
        batchers.set(sessionId, batcher);
      }
      return batcher;
    }

    function flush(sessionId: number, batcher: SessionBatcher) {
      batcher.timer = null;
      if (batcher.pendingBytes === 0 || ws.readyState !== WebSocket.OPEN) return;

      const seq = batcher.pending[batcher.pending.length - 1]!.seq;
      const payload = Buffer.allocUnsafe(batcher.pendingBytes);
      let offset = 0;
      for (const chunk of batcher.pending) {
        chunk.data.copy(payload, offset);
        offset += chunk.data.length;
      }

      batcher.pending = [];
      batcher.pendingBytes = 0;
      safeSend(ws, encodeData(sessionId, seq, payload));
      batcher.sentEntries.push({ seq, bytes: payload.length });
      batcher.unackedBytes += payload.length;
      batcher.lastSentSeq = seq;

      // backpressure: 이 viewer(ws)만 대상, PTY는 멈추지 않음
      if (batcher.acking) {
        if (!batcher.pausedForBackpressure && batcher.unackedBytes > ACK_HIGH_WATER) {
          batcher.pausedForBackpressure = true;
          manager.get(sessionId)?.pauseViewer(viewerId);
        }
      } else if (!batcher.pausedForBackpressure && ws.bufferedAmount > WS_HIGH_WATER) {
        batcher.pausedForBackpressure = true;
        // PTY pause 대신 viewer를 pause — 느린 viewer는 drop 후 snapshot 복구
        const session = manager.get(sessionId);
        if (session) session.pauseViewer(viewerId);

        batcher.drainTimer = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) {
            clearInterval(batcher.drainTimer!);
            batcher.drainTimer = null;
            return;
          }
          if (ws.bufferedAmount <= WS_LOW_WATER) {
            batcher.pausedForBackpressure = false;
            clearInterval(batcher.drainTimer!);
            batcher.drainTimer = null;
            if (session && !session.isDead) {
              session.resumeViewer(viewerId);
              // snapshot 전송으로 빠진 구간 복구
              safeSend(ws, encodeSnapshot(sessionId, session.lastSeq, Buffer.from(session.snapshot())));
              noteSnapshotSent(batcher, session.lastSeq);
            }
          }
        }, 25);
      }
    }

    /** A snapshot supersedes everything in flight — reset ack accounting. */
    function noteSnapshotSent(batcher: SessionBatcher, watermark: number) {
      batcher.sentEntries = [];
      batcher.unackedBytes = 0;
      batcher.lastSentSeq = watermark;
    }

    /** Ack through `seq`: shrink the unacked window; resume a paused viewer
     *  once the client has digested down to the low-water mark. */
    function handleViewerAck(sessionId: number, seq: number) {
      const batcher = batchers.get(sessionId);
      if (!batcher) return;
      batcher.acking = true;
      while (batcher.sentEntries.length > 0 && batcher.sentEntries[0]!.seq <= seq) {
        batcher.unackedBytes -= batcher.sentEntries.shift()!.bytes;
      }
      if (batcher.unackedBytes < 0) batcher.unackedBytes = 0;

      if (batcher.pausedForBackpressure && batcher.unackedBytes <= ACK_LOW_WATER) {
        batcher.pausedForBackpressure = false;
        const session = manager.get(sessionId);
        if (!session || session.isDead) return;
        session.resumeViewer(viewerId);
        // Catch up on what was dropped while paused: delta if the ring still
        // has it, one atomic snapshot otherwise.
        if (!session.shouldForceSnapshotReplay() && session.ring.canReplaySince(batcher.lastSentSeq)) {
          for (const chunk of session.ring.since(batcher.lastSentSeq)) {
            safeSend(ws, encodeData(sessionId, chunk.seq, chunk.data));
            batcher.sentEntries.push({ seq: chunk.seq, bytes: chunk.data.length });
            batcher.unackedBytes += chunk.data.length;
            batcher.lastSentSeq = chunk.seq;
          }
        } else {
          safeSend(ws, encodeSnapshot(sessionId, session.lastSeq, Buffer.from(session.snapshot())));
          noteSnapshotSent(batcher, session.lastSeq);
        }
      }
    }

    function enqueueData(sessionId: number, batcher: SessionBatcher, data: Buffer, seq: number) {
      if (batcher.pausedView || batcher.pausedForBackpressure) return;
      batcher.pending.push({ data, seq });
      batcher.pendingBytes += data.length;

      if (batcher.pendingBytes >= MAX_BATCH_BYTES) {
        if (batcher.timer) {
          clearTimeout(batcher.timer);
          batcher.timer = null;
        }
        flush(sessionId, batcher);
        return;
      }

      // Small data (typing echo): flush immediately, no batching delay
      if (batcher.pendingBytes <= IMMEDIATE_THRESHOLD && !batcher.timer) {
        queueMicrotask(() => flush(sessionId, batcher));
        return;
      }

      if (!batcher.timer) batcher.timer = setTimeout(() => flush(sessionId, batcher), BATCH_MS);
    }

    function wireSession(sessionId: number, mode: 'readwrite' | 'readonly' = 'readwrite') {
      const session = manager.get(sessionId);
      if (!session) return;

      // 같은 viewer가 이미 이 세션에 붙어있으면 제거 후 재등록
      if (session.hasViewer(viewerId)) {
        session.removeViewer(viewerId);
      }

      const batcher = getBatcher(sessionId);
      const dataCb = (data: Buffer, seq: number) => enqueueData(sessionId, batcher, data, seq);

      session.addViewer(viewerId, dataCb, mode);
      clientSessions.add(sessionId);

      if (!exitWired.has(sessionId)) {
        exitWired.add(sessionId);
        session.onExit((code) => {
          log(`EXIT session=${sessionId} code=${code}`);
          const b = batchers.get(sessionId);
          if (b) {
            if (b.timer) { clearTimeout(b.timer); b.timer = null; }
            if (b.drainTimer) { clearInterval(b.drainTimer); b.drainTimer = null; }
            flush(sessionId, b);
          }
          clientSessions.delete(sessionId);
          batchers.delete(sessionId);
          exitWired.delete(sessionId);
          safeSend(ws, encode(sessionId, CMD.DESTROY));
        });
      }
    }

    function cleanupBatcher(sessionId: number) {
      const batcher = batchers.get(sessionId);
      if (batcher) {
        if (batcher.timer) { clearTimeout(batcher.timer); batcher.timer = null; }
        if (batcher.drainTimer) { clearInterval(batcher.drainTimer); batcher.drainTimer = null; }
      }
      batchers.delete(sessionId);
    }

    ws.on('message', (raw) => {
      const buf = toBuffer(raw);
      if (buf.length < 3) return;

      // Inbound frames come from a client: their DATA is bare input bytes,
      // never seq-prefixed. decodeClientFrame, not decode.
      const frame = decodeClientFrame(buf);
      if (!frame) return;
      const { sessionId, cmd, payload } = frame;

      switch (cmd) {
        case CMD.HELLO:
          log('HELLO');
          break;

        case CMD.LIST: {
          const sessions = manager.list();
          log(`LIST -> ${sessions.length} sessions`);
          safeSend(ws, encode(0, CMD.LIST, jsonPayload(sessions)));
          break;
        }

        case CMD.CREATE: {
          let requestId: number | undefined;
          let opts: { cmd: string[]; cols: number; rows: number; cwd?: string } = { cmd: [DEFAULT_SHELL], cols: 80, rows: 24 };

          if (payload.length > 0) {
            try {
              const parsed = JSON.parse(payload.toString());
              requestId = parsed.requestId;
              if (Array.isArray(parsed.cmd)) opts.cmd = parsed.cmd;
              if (Number.isInteger(parsed.cols) && parsed.cols > 0) opts.cols = parsed.cols;
              if (Number.isInteger(parsed.rows) && parsed.rows > 0) opts.rows = parsed.rows;
              if (typeof parsed.cwd === 'string' && parsed.cwd.trim()) opts.cwd = parsed.cwd;
            } catch {
              safeSend(ws, encode(0, CMD.CREATE, jsonPayload({ requestId, ok: false, error: 'invalid payload' })));
              break;
            }
          }

          manager.create(opts.cmd, opts.cols, opts.rows, opts.cwd).then((session) => {
            log(`CREATE session=${session.id} pid=${session.pid} cmd=${opts.cmd.join(' ')}`);
            safeSend(ws, encode(session.id, CMD.CREATE, jsonPayload({ requestId, ok: true })));
            wireSession(session.id);
            // Send initial snapshot (holder may have buffered output before viewer was added)
            const snap = session.snapshot();
            if (snap.length > 0) {
              safeSend(ws, encodeSnapshot(session.id, session.lastSeq, Buffer.from(snap)));
            }
          }).catch((error) => {
            console.error('Failed to create session:', error);
            safeSend(ws, encode(0, CMD.CREATE, jsonPayload({ requestId, ok: false, error: 'spawn failed' })));
          });
          break;
        }

        case CMD.ATTACH: {
          const meta = parseJson<{ fromSeq?: number; cols?: number; rows?: number; mode?: string }>(payload);
          const session = manager.get(sessionId);
          if (!session || session.isDead) {
            safeSend(ws, encode(sessionId, CMD.ATTACH, jsonPayload({ ok: false, error: 'session not found' })));
            break;
          }

          const mode = meta?.mode === 'readonly' ? 'readonly' as const : 'readwrite' as const;

          // readwrite viewer만 resize 가능
          if (mode === 'readwrite' && meta?.cols && meta?.rows) {
            session.resize(meta.cols, meta.rows);
          }

          const fromSeq = meta?.fromSeq ?? 0;
          log(`ATTACH session=${sessionId} viewer=${viewerId.slice(0, 8)} mode=${mode} fromSeq=${fromSeq}`);
          safeSend(ws, encode(sessionId, CMD.ATTACH, jsonPayload({ ok: true, ...session.info() })));

          if (!session.shouldForceSnapshotReplay() && fromSeq > 0 && session.ring.canReplaySince(fromSeq)) {
            const batcher = getBatcher(sessionId);
            for (const chunk of session.ring.since(fromSeq)) {
              safeSend(ws, encodeData(sessionId, chunk.seq, chunk.data));
              batcher.sentEntries.push({ seq: chunk.seq, bytes: chunk.data.length });
              batcher.unackedBytes += chunk.data.length;
              batcher.lastSentSeq = chunk.seq;
            }
          } else {
            safeSend(ws, encodeSnapshot(sessionId, session.lastSeq, Buffer.from(session.snapshot())));
            noteSnapshotSent(getBatcher(sessionId), session.lastSeq);
          }

          wireSession(sessionId, mode);
          break;
        }

        case CMD.DETACH: {
          const session = manager.get(sessionId);
          if (session && !session.isDead) {
            session.removeViewer(viewerId);
            cleanupBatcher(sessionId);
            clientSessions.delete(sessionId);
            log(`DETACH session=${sessionId} viewer=${viewerId.slice(0, 8)}`);
          }
          safeSend(ws, encode(sessionId, CMD.DETACH, jsonPayload({ ok: true })));
          break;
        }

        case CMD.SNAPSHOT: {
          const session = manager.get(sessionId);
          if (session && !session.isDead) {
            safeSend(ws, encodeSnapshot(sessionId, session.lastSeq, Buffer.from(session.snapshot())));
            noteSnapshotSent(getBatcher(sessionId), session.lastSeq);
          }
          break;
        }

        case CMD.ACK: {
          const ackMeta = parseJson<{ seq: number }>(payload);
          if (ackMeta?.seq) {
            updateViewerAck(viewerId, sessionId, ackMeta.seq);
            handleViewerAck(sessionId, ackMeta.seq);
            minAckTrim(manager, sessionId);
          }
          break;
        }

        case CMD.PAUSE_VIEW: {
          const session = manager.get(sessionId);
          if (session) {
            session.pauseViewer(viewerId);
            const batcher = batchers.get(sessionId);
            if (batcher) batcher.pausedView = true;
            log(`PAUSE_VIEW session=${sessionId} viewer=${viewerId.slice(0, 8)}`);
          }
          break;
        }

        case CMD.RESUME_VIEW: {
          const session = manager.get(sessionId);
          const meta = parseJson<{ fromSeq?: number }>(payload);
          if (session && !session.isDead) {
            const batcher = getBatcher(sessionId);
            batcher.pausedView = false;

            const fromSeq = meta?.fromSeq ?? 0;
            if (!session.shouldForceSnapshotReplay() && fromSeq > 0 && session.ring.canReplaySince(fromSeq)) {
              for (const chunk of session.ring.since(fromSeq)) {
                safeSend(ws, encodeData(sessionId, chunk.seq, chunk.data));
                batcher.sentEntries.push({ seq: chunk.seq, bytes: chunk.data.length });
                batcher.unackedBytes += chunk.data.length;
                batcher.lastSentSeq = chunk.seq;
              }
            } else {
              safeSend(ws, encodeSnapshot(sessionId, session.lastSeq, Buffer.from(session.snapshot())));
              noteSnapshotSent(batcher, session.lastSeq);
            }

            session.resumeViewer(viewerId);
            log(`RESUME_VIEW session=${sessionId} viewer=${viewerId.slice(0, 8)} fromSeq=${fromSeq}`);
          }
          break;
        }

        case CMD.DATA: {
          // readonly viewer는 입력 무시
          const session = manager.get(sessionId);
          if (session && !session.isDead) {
            const viewer = session.getViewer(viewerId);
            if (viewer && viewer.mode === 'readwrite') {
              session.write(Buffer.from(payload));
            }
          }
          break;
        }

        case CMD.RESIZE:
          if (payload.length >= 4) {
            const cols = (payload[0] | (payload[1] << 8));
            const rows = (payload[2] | (payload[3] << 8));
            if (cols > 0 && rows > 0) {
              const session = manager.get(sessionId);
              if (session && !session.isDead) {
                // readonly viewer는 resize 무시
                const viewer = session.getViewer(viewerId);
                if (viewer && viewer.mode === 'readwrite') {
                  session.resize(cols, rows);
                }
              }
            }
          }
          break;

        case CMD.DESTROY:
          manager.destroy(sessionId);
          clientSessions.delete(sessionId);
          cleanupBatcher(sessionId);
          break;

        case CMD.PAUSE:
          manager.get(sessionId)?.pause();
          break;

        case CMD.RESUME:
          manager.get(sessionId)?.resume();
          break;
      }
    });

    ws.on('close', () => {
      log(`WS close viewer=${viewerId.slice(0, 8)} - detaching ${clientSessions.size} sessions`);
      manager.detachViewer(viewerId, clientSessions);
      removeViewerAcks(viewerId);
      for (const [, batcher] of batchers) {
        if (batcher.timer) clearTimeout(batcher.timer);
        if (batcher.drainTimer) clearInterval(batcher.drainTimer);
      }
      batchers.clear();
      clientSessions.clear();
    });
  });

  httpServer.keepAliveTimeout = 1000;
  httpServer.headersTimeout = 3000;
  httpServer.requestTimeout = 10000;

  await new Promise<void>((resolve) => httpServer.listen(port, resolve));

  return {
    manager,
    agentBus,
    wss,
    httpServer,
    close: async () => {
      if (gcTimer) clearInterval(gcTimer);
      fileBridge?.stop?.();
      agentBus?.close?.();
      // Save the workspace layouts first. They are a few KB, while
      // manager.shutdown() serializes every session's scrollback and can take
      // seconds. Running the heavy step first means a shutdown that hits the
      // deadline in index.ts loses the layouts — which is exactly how sessions
      // came back unreachable after a reboot before.
      await workspaceStore.save();
      await manager.shutdown(); // persist + don't kill holders
      await new Promise<void>((resolve, reject) => {
        wss.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}
