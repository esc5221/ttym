import { createServer as createHttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, resolve, basename as basenamePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { SessionManager } from './session-manager.js';
import { WorkspaceStore } from './workspace-store.js';
import { InteractionStore } from './interaction.js';
import { sweepRuntimeDir, sweepDropsDir } from './run-gc.js';
import { ConfigStore } from './config-file.js';
import { agentKindOf } from './agent-providers.js';
import { getHomeDir, type Session } from './session.js';
import { readMapPrompt, writeMapPrompt } from './map-prompt.js';
import { execFile } from 'node:child_process';

let mapRefreshInFlight = false;
import { readFileSync as readFileSyncFs, writeFileSync as writeFileSyncFs, unlinkSync, chmodSync, mkdirSync } from 'node:fs';
import { CMD, encode, encodeData, encodeSnapshot, decodeClientFrame, toBuffer, jsonPayload, parseJson } from './protocol.js';
import { API_VERSION, MIN_API_VERSION, PRODUCT_VERSION, isRuntimeMetaKey, runtimeMetaKeys, isRuntimeOnlyPatch } from '@ttym/protocol';

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
/** Drag-and-drop upload ceiling — a delivery mechanism, not a file store. */
const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
/** Delta replay above this falls back to one capped snapshot (tmux attach model). */
const REPLAY_MAX_BYTES = 64 * 1024;
/** Replay chunks merge into frames of about this size. */
const REPLAY_FRAME_BYTES = 16 * 1024;
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

/**
 * An agent-active flag with no expiry is a defect: it is set and cleared by
 * single hook curls, and one lost Stop (server restart window, crash) left a
 * tab dot pulsing for five days. The activity hook re-stamps agentActiveAt on
 * every write, so a genuinely running turn stays fresh; a flag whose stamp
 * has aged out — or that has no stamp at all (fossils from before this
 * existed) — reads as idle.
 */
export const AGENT_ACTIVE_TTL_MS = 15 * 60_000;
export function agentIsActive(meta: Record<string, unknown>, now = Date.now()): boolean {
  if (meta.claudeActive !== true && meta.codexActive !== true) return false;
  const stamp = meta.agentActiveAt;
  return typeof stamp === 'number' && now - stamp < AGENT_ACTIVE_TTL_MS;
}

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

let bootSafeMode = false;

function handleHttpApi(manager: SessionManager, workspaceStore: WorkspaceStore, interactions: InteractionStore, config: ConfigStore, req: IncomingMessage, res: ServerResponse, onAgentMeta?: (sessionId: number, meta: Record<string, unknown>) => void, onConfigChange?: (values: Record<string, string>) => void): boolean {
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

  // POST /api/upload?name=<filename> — the web half of file drag-and-drop.
  // A browser cannot learn a dropped file's real path (by design), so the
  // lineage inverts: the CONTENT travels here, lands in ~/.ttym/drops under
  // its original name, and the returned path is what gets typed into the
  // pane. The vibetunnel model, with Finder-style dedupe instead of uuids —
  // the agent reads the filename in the prompt, so the filename should mean
  // something. Native surfaces (desktop) never call this; they have the real
  // path.
  if (path === '/api/upload' && req.method === 'POST') {
    const rawName = url.searchParams.get('name') ?? '';
    // basename()은 신뢰 경계다 — 클라이언트가 보낸 이름의 경로 성분은 버린다.
    const safeName = basenamePath(rawName).replace(/^\.+/, '').trim();
    if (!safeName) { json(400, { error: 'name required' }); return true; }

    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      total += chunk.length;
      if (total > UPLOAD_MAX_BYTES) {
        aborted = true;
        json(413, { error: `file exceeds ${UPLOAD_MAX_BYTES / 1024 / 1024}MB limit` });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      void (async () => {
        const dir = resolve(getHomeDir(), 'drops');
        await mkdir(dir, { recursive: true });
        const dot = safeName.lastIndexOf('.');
        const stem = dot > 0 ? safeName.slice(0, dot) : safeName;
        const ext = dot > 0 ? safeName.slice(dot) : '';
        // Finder-style collision handling: image.png, image-2.png, … The 'wx'
        // flag makes each claim atomic, so two same-name drops cannot land on
        // one file even if they race.
        for (let i = 1; i <= 100; i++) {
          const candidate = i === 1 ? safeName : `${stem}-${i}${ext}`;
          const target = resolve(dir, candidate);
          try {
            await writeFile(target, Buffer.concat(chunks, total), { flag: 'wx' });
            log(`UPLOAD ${candidate} ${total}B`);
            json(201, { path: target, name: candidate, bytes: total });
            return;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          }
        }
        json(507, { error: 'too many name collisions' });
      })().catch(() => { if (!res.headersSent) json(500, { error: 'write failed' }); });
    });
    return true;
  }

  // GET|PATCH /api/config — the flat key=value file, served so every surface
  // (web, desktop, each window) reads and writes the same truth.
  if (path === '/api/config') {
    if (req.method === 'GET') {
      json(200, { values: config.get() });
      return true;
    }
    if (req.method === 'PATCH') {
      readBody().then(async (body) => {
        try {
          const patch = JSON.parse(body);
          if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
            json(400, { error: 'body must be an object of key: string|null' });
            return;
          }
          for (const value of Object.values(patch)) {
            if (value !== null && typeof value !== 'string') {
              json(400, { error: 'values must be strings, or null to delete' });
              return;
            }
          }
          const values = await config.patch(patch as Record<string, string | null>);
          log(`CONFIG PATCH keys=${Object.keys(patch).join(',')}`);
          onConfigChange?.(values);
          json(200, { values });
        } catch {
          json(400, { error: 'invalid body' });
        }
      });
      return true;
    }
  }

  // GET /api/version — lets a client refuse an incompatible server
  if (path === '/api/version' && req.method === 'GET') {
    json(200, { apiVersion: API_VERSION, minApiVersion: MIN_API_VERSION, version: PRODUCT_VERSION, role: 'ttym-server', ...(bootSafeMode ? { safeMode: true } : {}) });
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
      // The CR waits a beat: two back-to-back writes can land in one PTY
      // read, and a TUI's paste heuristics then swallow the CR as a pasted
      // newline instead of a submit — the prompt sits in the input box
      // forever. Longer prompts widen the paste window, which is why this
      // was a timing lottery. A shell's LF has no such heuristics.
      if (submit === 'cr') {
        setTimeout(() => { if (!session.isDead) session.write(Buffer.from([0x0d])); }, 75);
      } else if (submit === 'lf') {
        session.write(Buffer.from([0x0a]));
      }
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
        // Server stamps liveness itself — hooks only say "active", the clock
        // that decides how long that claim holds is not theirs to set.
        if (patch.claudeActive === true || patch.codexActive === true) {
          patch.agentActiveAt = Date.now();
        }
        const merged = await manager.setMeta(id, patch);
        log(`AGENT META session=${id} keys=${Object.keys(patch).join(',')}`);
        onAgentMeta?.(id, merged as Record<string, unknown>);
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
      void manager.getMeta(id).catch(() => ({})).then(async (meta) => {
        const settled = await interactions.finish(session, outcome, meta as Record<string, unknown>);
        log(`HTTP STOP session=${id} outcome=${outcome} interaction=${settled?.id ?? 'none'} source=${settled?.transcriptSource ?? '-'}`);
        json(200, { ok: true, interaction: settled });
      });
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

  // GET /api/sessions/:id/commands — the command index (OSC 133/633).
  // 쉘 통합이 없는 세션은 빈 목록이 정상이다 — 신호가 안 오면 안 쌓일 뿐.
  const commandsMatch = path.match(/^\/api\/sessions\/(\d+)\/commands$/);
  if (commandsMatch && req.method === 'GET') {
    const id = parseInt(commandsMatch[1], 10);
    const session = manager.get(id);
    if (!session || session.isDead) { json(404, { error: 'not found' }); return true; }
    const limitRaw = url.searchParams.get('limit');
    const limit = limitRaw && /^\d+$/.test(limitRaw) ? Math.min(parseInt(limitRaw, 10), 500) : 50;
    json(200, {
      integration: session.commands.signalsSeen,
      total: session.commands.total,
      commands: session.commands.list(limit),
    });
    return true;
  }

  // GET /api/sessions/:id/commands/:n/output — 그 명령의 출력 구간만 절취.
  // 출력 바이트의 수명은 ring이 정한다 — 밀려났으면 truncated로 정직하게.
  const cmdOutputMatch = path.match(/^\/api\/sessions\/(\d+)\/commands\/(\d+|last)\/output$/);
  if (cmdOutputMatch && req.method === 'GET') {
    const id = parseInt(cmdOutputMatch[1], 10);
    const session = manager.get(id);
    if (!session || session.isDead) { json(404, { error: 'not found' }); return true; }
    const record = cmdOutputMatch[2] === 'last'
      ? session.commands.list(1)[0]
      : session.commands.get(parseInt(cmdOutputMatch[2], 10));
    if (!record) { json(404, { error: 'no such command' }); return true; }
    const endSeq = record.endSeq ?? session.lastSeq + 1; // 진행 중이면 현재까지
    const { data, truncated } = session.ring.slice(record.startSeq, endSeq);
    json(200, {
      n: record.n, cmdline: record.cmdline, exitCode: record.exitCode,
      running: record.endedAt === null, truncated,
      output: data.toString('utf8'),
    });
    return true;
  }

  // POST /api/sessions/:id/commands — 명령 실행 + 완료 blocking 대기 (shell-await).
  // 쉘 통합 신호가 없는 세션은 완료를 알 길이 없으므로 409로 거절한다.
  if (commandsMatch && req.method === 'POST') {
    const id = parseInt(commandsMatch[1], 10);
    readBody().then(async (body) => {
      const session = manager.get(id);
      if (!session || session.isDead) { json(404, { error: 'not found' }); return; }
      if (!session.commands.signalsSeen) {
        json(409, { error: 'no shell integration signals from this session' });
        return;
      }
      let command: string; let timeoutMs: number;
      try {
        const parsed = JSON.parse(body);
        if (typeof parsed.command !== 'string' || !parsed.command.trim()) throw new Error('bad');
        command = parsed.command.replace(/[\r\n]+$/, '');
        timeoutMs = Number.isFinite(parsed.timeoutMs) ? Math.min(parsed.timeoutMs, 600_000) : 120_000;
      } catch {
        json(400, { error: 'body must be {command, timeoutMs?}' });
        return;
      }
      const afterN = session.commands.total;
      session.write(Buffer.from(command + '\n'));
      log(`HTTP CMD-RUN session=${id} len=${command.length}`);
      const record = await session.commands.waitForClose(afterN, timeoutMs);
      if (!record) {
        json(200, { completed: false, command: null, output: null, truncated: false });
        return;
      }
      const { data, truncated } = session.ring.slice(record.startSeq, record.endSeq ?? session.lastSeq + 1);
      json(200, { completed: true, command: record, truncated, output: data.toString('utf8') });
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
      const agentKind = agentKindOf(meta);
      json(200, {
        terminal: {
          cols: session.cols,
          rows: session.rows,
          lastSeq: session.ring.nextSeq - 1,
          appliedOffset: session.appliedOffset,
          generation: session.generation,
          recoveryGap: session.recoveryGap,
          integrity: session.integrity,
        },
        process: {
          pid: session.childPid,
          state: session.isDead ? (session.evicted ? 'evicted' : 'dead') : 'running',
          exitCode: session.exitCode,
        },
        agent: {
          kind: agentKind,
          externalSessionId: meta.claudeSessionId ?? meta.codexSessionId ?? null,
          active: agentIsActive(meta),
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

  // GET /api/agent-states — 모든 라이브 세션의 {kind, active} 한 판.
  // 실측에서 창 10개 × 27세션의 60초 안전망 스윕이 분당 270커넥션을 만들었다
  // (server는 단명 CLI 소켓 누수 때문에 Connection: close가 계약이다 — 8c3cb6c).
  // 요청 수를 줄이는 게 옳은 방향이지, keep-alive를 되살리는 게 아니다.
  if (path === '/api/agent-states' && req.method === 'GET') {
    const sessions = manager.list();
    Promise.all(sessions.map(async (info) => {
      const meta = await manager.getMeta(info.id);
      return [info.id, { kind: agentKindOf(meta), active: agentIsActive(meta) }] as const;
    })).then((entries) => {
      json(200, Object.fromEntries(entries));
    }).catch(() => json(500, { error: 'assembly failed' }));
    return true;
  }

  // GET /api/map — 작업 지도 한 판을 서버가 조립해서 준다: 살아있는 세션마다
  // AI 요약(meta.mapSummary, user-owned 절반)과 신선도, workspace마다 배치(map).
  // 신선도는 seq에 정직하다: atSeq 이후 링이 전진했으면 stale — 낡음을 숨기지 않는다.
  if (path === '/api/map' && req.method === 'GET') {
    const sessions = manager.list();
    Promise.all(sessions.map(async (info) => {
      const meta = await manager.getMeta(info.id);
      const raw = meta.mapSummary;
      const summary = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
      const atSeq = summary && typeof summary.atSeq === 'number' ? summary.atSeq : null;
      return {
        id: info.id,
        cmd: info.cmd,
        createdAt: info.createdAt,
        lastSeq: info.lastSeq,
        agentKind: agentKindOf(meta),
        agentActive: agentIsActive(meta),
        summary,
        stale: atSeq === null || info.lastSeq > atSeq,
      };
    })).then((rows) => {
      json(200, { generatedAt: Date.now(), workspaces: workspaceStore.list(), sessions: rows });
    }).catch(() => json(500, { error: 'map assembly failed' }));
    return true;
  }

  // GET|PUT /api/map/prompt — 요약기 지시문. 파일(map-prompt.txt)이 있으면
  // 그것, 없으면 내장 기본값. 빈 문자열 PUT = 리셋. 단일 원천은 서버다 —
  // CLI도 여기서 받아 쓰므로 사본이 두 벌 생기지 않는다.
  if (path === '/api/map/prompt') {
    if (req.method === 'GET') {
      readMapPrompt().then((r) => json(200, r));
      return true;
    }
    if (req.method === 'PUT') {
      readBody().then(async (body) => {
        try {
          const { prompt } = JSON.parse(body);
          if (typeof prompt !== 'string') { json(400, { error: 'prompt must be string' }); return; }
          json(200, await writeMapPrompt(prompt));
        } catch {
          json(400, { error: 'invalid body' });
        }
      });
      return true;
    }
  }

  // POST /api/map/refresh — 웹의 "지금 정리" 버튼. 요약 로직을 서버에 복제하지
  // 않고 동봉된 CLI를 스폰한다 — 로직의 단일 원천은 CLI 하나로 유지된다.
  // note는 일회성 지시로 지시문 뒤에 붙는다(저장 안 됨).
  if (path === '/api/map/refresh' && req.method === 'POST') {
    // single-flight: 요약은 브라우저가 떠나도 서버에서 완주한다. 그 사이 새
    // 페이지가 또 누르면 모델 호출이 이중으로 나가므로 하나만 허용한다.
    if (mapRefreshInFlight) { json(409, { error: 'refresh already running' }); return true; }
    mapRefreshInFlight = true;
    readBody().then((body) => {
      let note = '';
      try {
        const parsed = body ? JSON.parse(body) : {};
        if (parsed && typeof parsed === 'object' && typeof parsed.note === 'string') note = parsed.note;
        else if (parsed && typeof parsed === 'object' && parsed.note !== undefined) { json(400, { error: 'note must be string' }); return; }
      } catch { json(400, { error: 'invalid body' }); return; }
      const cliPath = resolve(SERVER_DIR, 'ttym');
      const port = req.socket.localPort ?? 7690;
      const cliArgs = [cliPath, 'map', 'refresh', '--json', '--port', String(port), ...(note.trim() ? ['--note', note.trim()] : [])];
      execFile(process.execPath, cliArgs, { timeout: 200_000 }, (error, stdout, stderr) => {
        mapRefreshInFlight = false;
        if (error) { json(502, { error: (stderr || error.message).trim().slice(0, 300) }); return; }
        try { json(200, JSON.parse(stdout)); } catch { json(200, { output: stdout.trim().slice(0, 300) }); }
      });
    }).catch(() => { mapRefreshInFlight = false; });
    return true;
  }

  // GET|POST /api/map/api-key — 요약기 API 키는 write-only다. config는 모든
  // 클라이언트에 서빙되므로 절대 싣지 않고, 파일(0600)로만 산다. GET은 존재
  // 여부만 답한다 — 키가 이 API로 되돌아 나가는 일은 없다.
  if (path === '/api/map/api-key') {
    const keyPath = resolve(getHomeDir(), 'map-api-key');
    if (req.method === 'GET') {
      let set = false;
      try { set = readFileSyncFs(keyPath, 'utf8').trim().length > 0; } catch {}
      json(200, { set });
      return true;
    }
    if (req.method === 'POST') {
      readBody().then((body) => {
        try {
          const { key } = JSON.parse(body);
          if (typeof key !== 'string') { json(400, { error: 'key must be string' }); return; }
          if (!key.trim()) {
            try { unlinkSync(keyPath); } catch {}
            json(200, { set: false });
            return;
          }
          writeFileSyncFs(keyPath, key.trim() + '\n', { mode: 0o600 });
          chmodSync(keyPath, 0o600);
          json(200, { set: true });
        } catch {
          json(400, { error: 'invalid body' });
        }
      });
      return true;
    }
  }

  // ───── Workspace API ─────

  // GET /api/workspaces
  if (path === '/api/workspaces' && req.method === 'GET') {
    json(200, workspaceStore.list());
    return true;
  }

  // PATCH /api/workspaces/order — 탭 재배치. 전체 순열, 집합 불일치는 409.
  if (path === '/api/workspaces/order' && req.method === 'PATCH') {
    readBody().then((body) => {
      try {
        const { ids } = JSON.parse(body);
        if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) {
          json(400, { error: 'body must be {ids: string[]}' }); return;
        }
        if (!workspaceStore.reorder(ids)) {
          json(409, { error: 'ids do not match the current workspace set' }); return;
        }
        json(200, { ok: true });
      } catch {
        json(400, { error: 'invalid body' });
      }
    });
    return true;
  }

  // POST /api/workspaces
  if (path === '/api/workspaces' && req.method === 'POST') {
    readBody().then((body) => {
      try {
        const { id, name, layout, members } = JSON.parse(body);
        if (!id || !name || !layout) { json(400, { error: 'id, name, layout required' }); return; }
        const ws = workspaceStore.create(id, name, layout, members || []);
        log(`WORKSPACE CREATE id=${id} name=${name}`);
        json(201, ws);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'invalid body';
        json(message.includes('already exists') ? 409 : 400, { error: message });
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
        } catch (error) {
          const message = error instanceof Error ? error.message : 'invalid body';
          json(message.includes('already exists') ? 409 : 400, { error: message });
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
          direction,
        } = JSON.parse(body || '{}');
        const dir = ['right', 'left', 'down', 'up'].includes(direction) ? direction : 'right';

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
          }, dir);
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
  // 포트 선점 검사 — holder를 건드리기 전에. 다른 서버가 이미 살아있다면
  // 여기서 즉사해야 한다: 복구 경로가 lease 거절을 만나고 workspace 복원이
  // 같은 id로 사칭 holder를 소환하는 연쇄(2026-08-13 사고)의 원천 차단.
  // 아래 heldByOthers 가드가 안전벨트, 이건 문단속이다.
  await new Promise<void>((portFree, portTaken) => {
    const probe = createNetServer();
    probe.once('error', portTaken);
    probe.listen(port, process.env.TTYM_BIND || '127.0.0.1', () => probe.close(() => portFree()));
  });

  const manager = new SessionManager();

  // Load workspace store first so we know which session IDs deserve restore.
  // Sessions not referenced by any workspace remain on disk but stay dormant —
  // they can be revived later by adding them back to a workspace.
  const workspaceStore = new WorkspaceStore(manager.runtimeDir);
  await workspaceStore.load();
  const markCleanExit = () => {
    try {
      const p = resolve(getHomeDir(), 'boot.json');
      const history = JSON.parse(readFileSyncFs(p, 'utf8')) as Array<{ startedAt: number; exitedAt?: number }>;
      if (history.length) history[history.length - 1].exitedAt = Date.now();
      writeFileSyncFs(p, JSON.stringify(history));
    } catch {}
  };
  const configStore = new ConfigStore(resolve(getHomeDir(), 'config'));
  await configStore.load();
  const interactions = new InteractionStore();
  const restoreAllowlist = new Set<number>();
  for (const ws of workspaceStore.list()) {
    for (const m of ws.members) restoreAllowlist.add(m.sessionId);
  }

  // safe-mode: KeepAlive 아래에서 복구 자체가 죽음의 원인이면(poison 세션)
  // 매 재기동이 같은 복구를 반복한다. 직전 부팅들이 전부 조기 사망이면
  // 이번 부팅은 세션 복구를 건너뛴다 — holder는 살아 있으니 데이터 손실은
  // 없고, API·로그로 수동 진단이 가능해진다.
  const bootLogPath = resolve(getHomeDir(), 'boot.json');
  let safeMode = false;
  try {
    const history = JSON.parse(readFileSyncFs(bootLogPath, 'utf8')) as Array<{ startedAt: number; exitedAt?: number }>;
    const recent = history.slice(-3);
    // "조기 사망" = 정상 종료 기록 없이, 다음 부팅(마지막은 지금)까지 30초 미만.
    // 30초인 이유: 수명 + 감독자의 재기동 스로틀(10초)이 간격에 합산되기 때문.
    safeMode = recent.length === 3 && recent.every((b, i) => {
      const next = history[history.length - 3 + i + 1];
      const gap = (next?.startedAt ?? Date.now()) - b.startedAt;
      return !b.exitedAt && gap < 30_000;
    });
  } catch {}
  try {
    mkdirSync(getHomeDir(), { recursive: true });
    let history: Array<{ startedAt: number; exitedAt?: number }> = [];
    try { history = JSON.parse(readFileSyncFs(bootLogPath, 'utf8')); } catch {}
    history.push({ startedAt: Date.now() });
    writeFileSyncFs(bootLogPath, JSON.stringify(history.slice(-10)));
  } catch {} // 브레드크럼이 부팅을 죽여선 안 된다
  bootSafeMode = safeMode;
  if (safeMode) {
    log('SAFE MODE: last 3 boots died within 10s — skipping session recovery (holders untouched)');
  }

  await manager.boot(safeMode ? new Set<number>() : restoreAllowlist);

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
      sweepDropsDir(resolve(getHomeDir(), 'drops'), gcDays * 24 * 60 * 60 * 1000)
        .then(({ removed }) => {
          if (removed.length > 0) console.log(`[gc] swept ${removed.length} expired drops`);
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
    if (handleHttpApi(manager, workspaceStore, interactions, configStore, req, res, broadcastAgentState, broadcastConfig)) return;
    if (handleDemoApp(req, res)) return;
    res.writeHead(404);
    res.end('not found');
  });
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  // Workspace changes push to every connected client — full tree +
  // generation. Clients stop polling; a missed event costs nothing because
  // the next one carries the entire state again.
  // Agent state pushes the moment a hook writes it — the last poll the web
  // client ran (3s runtime sweep) dies with this.
  const lastAnnouncedActive = new Map<number, boolean>();

  // Expiry has no natural push moment — nothing "happens" when a stamp ages
  // out, so a dot already on screen would pulse until the next unrelated
  // event. The sweeper turns expiry into an event: any session last announced
  // as active whose stamp has gone stale gets one idle broadcast.
  const agentExpirySweep = setInterval(() => {
    for (const info of manager.list()) {
      if (lastAnnouncedActive.get(info.id) !== true) continue;
      manager.getMeta(info.id).then((meta) => {
        if (!agentIsActive(meta)) broadcastAgentState(info.id, meta);
      }).catch(() => {});
    }
  }, 60_000);
  agentExpirySweep.unref();

  function broadcastAgentState(sessionId: number, meta: Record<string, unknown>) {
    const kind = agentKindOf(meta);
    const event = {
      sessionId,
      kind,
      active: agentIsActive(meta),
    };
    lastAnnouncedActive.set(sessionId, event.active);
    const frame = encode(0, CMD.AGENT, jsonPayload(event));
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try { client.send(frame); } catch {}
      }
    }
  }

  // ── map 요약 주기: 서버 내장 타이머 ──
  // 별도 launchd plist였던 것을 흡수한다 — 서버가 유일한 상주 프로세스니
  // 주기의 거처도 여기다. 기본 off: 화면이 모델로 나가는 건 명시적 선택.
  // 요약 로직은 여전히 동봉 CLI(단일 원천), 실패는 서버 본체에 전파되지 않는다.
  let mapTimer: ReturnType<typeof setInterval> | null = null;
  let mapRunning = false;
  let mapFailures = 0;
  function parseMapInterval(raw: string | undefined): number {
    if (!raw) return 0;
    const m = String(raw).trim().match(/^(\d+)\s*(s|m|h)?$/);
    if (!m) return 0;
    const n = parseInt(m[1], 10);
    const unit = m[2] === 'h' ? 3600 : m[2] === 's' ? 1 : 60; // 단위 없으면 분
    const seconds = n * unit;
    return seconds >= 60 ? seconds * 1000 : 0; // 1분 미만은 오설정으로 보고 무시
  }
  function runMapRefresh() {
    if (mapRunning) return;
    mapRunning = true;
    const cliPath = resolve(SERVER_DIR, 'ttym');
    // launchd가 띄운 서버는 최소 PATH라 claude 바이너리를 못 찾는다(실측 회귀).
    const path = [process.env.PATH, `${process.env.HOME}/.local/bin`, '/opt/homebrew/bin', '/usr/local/bin']
      .filter(Boolean).join(':');
    execFile(process.execPath, [cliPath, 'map', 'refresh', '--port', String(port)], {
      timeout: 200_000,
      env: { ...process.env, PATH: path },
    }, (error, _stdout, stderr) => {
      mapRunning = false;
      if (error) {
        mapFailures += 1;
        log(`MAP timer refresh failed (${mapFailures} in a row): ${(stderr || error.message).trim().slice(0, 160)}`);
        if (mapFailures >= 5 && mapTimer) {
          clearInterval(mapTimer);
          mapTimer = null;
          log('MAP timer suspended after 5 consecutive failures — fix the backend, then re-save map-interval');
        }
      } else {
        mapFailures = 0;
      }
    });
  }
  function armMapTimer(values: Record<string, string>) {
    if (mapTimer) { clearInterval(mapTimer); mapTimer = null; }
    const ms = parseMapInterval(values['map-interval']);
    if (ms <= 0) return;
    mapFailures = 0;
    mapTimer = setInterval(runMapRefresh, ms);
    mapTimer.unref();
    log(`MAP timer armed: every ${Math.round(ms / 1000)}s`);
  }
  armMapTimer(configStore.get());

  function broadcastConfig(values: Record<string, string>) {
    armMapTimer(values); // 설정이 바뀌면 즉시 재장전 — 재시작 불필요
    const frame = encode(0, CMD.CONFIG, jsonPayload({ values }));
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try { client.send(frame); } catch {}
      }
    }
  }

  const unsubscribeWorkspaceChanges = workspaceStore.onChange((event) => {
    const frame = encode(0, CMD.WORKSPACE, jsonPayload(event));
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try { client.send(frame); } catch {}
      }
    }
  });

  wss.on('connection', (ws: WebSocket) => {
    const viewerId = randomUUID();
    const clientSessions = new Set<number>();
    const batchers = new Map<number, SessionBatcher>();
    const exitWired = new Set<number>(); // prevent duplicate onExit per session
    // 기하 변경을 이 연결의 viewer에게 밀어주는 구독 — 연결 종료 시 해지
    const geometryUnsubs = new Map<number, () => void>();

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
              safeSend(ws, encodeSnapshot(sessionId, session.lastSeq, Buffer.from(session.viewerSnapshot())));
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

    /**
     * A resync starts the viewer's stream accounting over. Whatever the
     * batcher believed before — a paused view, a backpressure stall with its
     * drain timer, batched chunks the resync is about to supersede, an ack
     * window for frames now irrelevant — kept ruling AFTER the resync, and a
     * re-attached viewer could sit behind a stale pausedView flag dropping
     * every live byte with no signal that would ever clear it.
     */
    function resetBatcherForResync(batcher: SessionBatcher) {
      if (batcher.timer) { clearTimeout(batcher.timer); batcher.timer = null; }
      if (batcher.drainTimer) { clearInterval(batcher.drainTimer); batcher.drainTimer = null; }
      batcher.pending = [];
      batcher.pendingBytes = 0;
      batcher.sentEntries = [];
      batcher.unackedBytes = 0;
      batcher.pausedForBackpressure = false;
    }

    /**
     * Resync a viewer at `fromSeq`: delta replay when it is small and honest,
     * snapshot otherwise. Three ways a delta can lie or hurt, all measured on
     * production before this existed:
     *  - fromSeq ahead of the session (watermark from a previous server boot;
     *    seqs restart at 1 on recovery) — since() is empty, the viewer would
     *    get nothing and stay blank forever;
     *  - delta bigger than REPLAY_MAX_BYTES — a long-hidden pane can owe the
     *    whole ring (1MB), which replays as a slow visible pour where one
     *    capped snapshot paints atomically;
     *  - chunk-per-frame replay — 1MB of ring arrived as 137k tiny frames.
     *    Replay merges chunks into few frames, each stamped with the last
     *    seq it contains.
     */
    function sendResync(sessionId: number, session: Session, batcher: SessionBatcher, fromSeq: number) {
      if (!session.shouldForceSnapshotReplay() && session.integrity === 'healthy' && fromSeq > 0
          && fromSeq <= session.lastSeq && session.ring.canReplaySince(fromSeq)) {
        const chunks = session.ring.since(fromSeq);
        let total = 0;
        for (const chunk of chunks) total += chunk.data.length;
        if (total <= REPLAY_MAX_BYTES) {
          let group: Buffer[] = [];
          let groupBytes = 0;
          let groupSeq = fromSeq;
          const flushGroup = () => {
            if (groupBytes === 0) return;
            safeSend(ws, encodeData(sessionId, groupSeq, Buffer.concat(group, groupBytes)));
            batcher.sentEntries.push({ seq: groupSeq, bytes: groupBytes });
            batcher.unackedBytes += groupBytes;
            batcher.lastSentSeq = groupSeq;
            group = [];
            groupBytes = 0;
          };
          for (const chunk of chunks) {
            group.push(chunk.data);
            groupBytes += chunk.data.length;
            groupSeq = chunk.seq;
            if (groupBytes >= REPLAY_FRAME_BYTES) flushGroup();
          }
          flushGroup();
          return;
        }
      }
      safeSend(ws, encodeSnapshot(sessionId, session.lastSeq, Buffer.from(session.viewerSnapshot())));
      noteSnapshotSent(batcher, session.lastSeq);
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
          safeSend(ws, encodeSnapshot(sessionId, session.lastSeq, Buffer.from(session.viewerSnapshot())));
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

      // 서버→클라 RESIZE: PTY 기하의 진실은 서버 하나고, follow 뷰어(모바일)는
      // 이 프레임으로 추종한다. fit 뷰어는 무시 — 수신은 선언일 뿐 강제가 아니다.
      if (!geometryUnsubs.has(sessionId)) {
        geometryUnsubs.set(sessionId, session.onGeometry((cols, rows) => {
          const geo = Buffer.allocUnsafe(4);
          geo.writeUInt16LE(cols, 0);
          geo.writeUInt16LE(rows, 2);
          safeSend(ws, encode(sessionId, CMD.RESIZE, geo));
        }));
      }

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
          geometryUnsubs.get(sessionId)?.();
          geometryUnsubs.delete(sessionId);
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
            // Send initial snapshot (holder may have buffered output before
            // viewer was added). Booked like every other snapshot — without
            // noteSnapshotSent the batcher's lastSentSeq stayed 0 and the
            // client's ack of this very watermark read as a claim about
            // frames never sent.
            const snap = session.snapshot();
            if (snap.length > 0) {
              safeSend(ws, encodeSnapshot(session.id, session.lastSeq, Buffer.from(snap)));
              noteSnapshotSent(getBatcher(session.id), session.lastSeq);
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

          {
            const batcher = getBatcher(sessionId);
            resetBatcherForResync(batcher);
            batcher.pausedView = false; // attaching IS viewing
            sendResync(sessionId, session, batcher, fromSeq);
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
            // A departed viewer's ack floor must not keep the ring from
            // trimming for everyone else.
            viewerAcks.get(viewerId)?.delete(sessionId);
            minAckTrim(manager, sessionId);
            log(`DETACH session=${sessionId} viewer=${viewerId.slice(0, 8)}`);
          }
          safeSend(ws, encode(sessionId, CMD.DETACH, jsonPayload({ ok: true })));
          break;
        }

        case CMD.SNAPSHOT: {
          const session = manager.get(sessionId);
          if (session && !session.isDead) {
            safeSend(ws, encodeSnapshot(sessionId, session.lastSeq, Buffer.from(session.viewerSnapshot())));
            noteSnapshotSent(getBatcher(sessionId), session.lastSeq);
          }
          break;
        }

        case CMD.ACK: {
          const ackMeta = parseJson<{ seq: number }>(payload);
          const seq = ackMeta?.seq;
          // An ack is a claim ("I parsed through seq") that feeds directly
          // into ring truncation — so it is validated like one: integral,
          // monotonic for this viewer, and no further than what this viewer
          // was actually sent. One bogus future ack used to flush the entire
          // ring for every viewer.
          if (!Number.isInteger(seq) || seq! <= 0) break;
          const ackBatcher = batchers.get(sessionId);
          if (!ackBatcher || seq! > ackBatcher.lastSentSeq) break;
          const prevAck = viewerAcks.get(viewerId)?.get(sessionId) ?? 0;
          if (seq! < prevAck) break;
          updateViewerAck(viewerId, sessionId, seq!);
          handleViewerAck(sessionId, seq!);
          minAckTrim(manager, sessionId);
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
            resetBatcherForResync(batcher);
            batcher.pausedView = false;

            const fromSeq = meta?.fromSeq ?? 0;
            sendResync(sessionId, session, batcher, fromSeq);

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
      const ackedSessions = [...(viewerAcks.get(viewerId)?.keys() ?? [])];
      removeViewerAcks(viewerId);
      for (const sid of ackedSessions) minAckTrim(manager, sid);
      for (const [, batcher] of batchers) {
        if (batcher.timer) clearTimeout(batcher.timer);
        if (batcher.drainTimer) clearInterval(batcher.drainTimer);
      }
      batchers.clear();
      clientSessions.clear();
      for (const unsub of geometryUnsubs.values()) unsub();
      geometryUnsubs.clear();
    });
  });

  httpServer.keepAliveTimeout = 1000;
  httpServer.headersTimeout = 3000;
  httpServer.requestTimeout = 10000;

  // 기본은 loopback만 — 이 API는 무인증이라 열린 인터페이스가 곧 원격 셸이다.
  // LAN 노출은 TTYM_BIND=0.0.0.0 (또는 특정 IP)로 부팅 시점에만 선택한다.
  // config가 아닌 env인 이유: PATCH /api/config가 무인증이라, 파일에 두면
  // 프록시 너머에서 바인드를 여는 원격 스위치가 된다.
  const bindHost = process.env.TTYM_BIND || '127.0.0.1';
  await new Promise<void>((resolve) => httpServer.listen(port, bindHost, resolve));
  // Hooks address the server that owns their session — not a hardcoded 7690.
  const boundPort = (httpServer.address() as { port: number } | null)?.port ?? port;
  manager.setExtraSessionEnv({ TTYM_PORT: String(boundPort) });

  return {
    manager,
    agentBus,
    wss,
    httpServer,
    close: async () => {
      markCleanExit();
      clearInterval(agentExpirySweep);
      unsubscribeWorkspaceChanges();
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
