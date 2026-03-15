import { createServer as createHttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { SessionManager } from './session-manager.js';
import { WorkspaceStore } from './workspace-store.js';
import { CMD, encode, encodeData, decode, toBuffer, jsonPayload, parseJson } from './protocol.js';

const DEFAULT_SHELL = process.env.SHELL || '/bin/bash';

const BATCH_MS = 12;
const MAX_BATCH_BYTES = 64 * 1024;
const IMMEDIATE_THRESHOLD = 256; // bytes — flush immediately for interactive typing
const WS_HIGH_WATER = 1 << 20;
const WS_LOW_WATER = 1 << 18;

const DEBUG = true;
const log = (...args: unknown[]) => DEBUG && console.log(`[srv ${new Date().toISOString().slice(11, 23)}]`, ...args);

function safeSend(ws: WebSocket, data: Buffer): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  try { ws.send(data); return true; } catch { return false; }
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

function handleHttpApi(manager: SessionManager, workspaceStore: WorkspaceStore, req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }

  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const readBody = (): Promise<string> => new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => resolve(body));
  });

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
        const verify = opts.verify === true;
        const session = await manager.create(cmd, cols, rows);
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
  await manager.boot();
  const workspaceStore = new WorkspaceStore(manager.runtimeDir);
  await workspaceStore.load();

  // Agent Bus is optional and currently disabled in the bundled server path.
  const agentBus = null as { close?: () => void } | null;
  const fileBridge = null as { stop?: () => void } | null;
  const handleAgentRequest = null as ((req: IncomingMessage, res: ServerResponse) => boolean) | null;

  // Inject TTYM_BUS_URL into SessionManager for holder env
  manager.setBusUrl(`http://127.0.0.1:${port}/api`);

  // Remap workspace layout sessionIds after reboot restore
  if (manager.lastIdMap.size > 0) {
    workspaceStore.remapSessionIds(manager.lastIdMap);
  }

  const httpServer = createHttpServer((req, res) => {
    if (handleAgentRequest && handleAgentRequest(req, res)) return;
    if (handleHttpApi(manager, workspaceStore, req, res)) return;
    res.writeHead(404);
    res.end('not found');
  });
  const wss = new WebSocketServer({ server: httpServer });

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

      // backpressure: 이 viewer(ws)만 대상, PTY는 멈추지 않음
      if (!batcher.pausedForBackpressure && ws.bufferedAmount > WS_HIGH_WATER) {
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
              safeSend(ws, encode(sessionId, CMD.SNAPSHOT, Buffer.from(session.snapshot())));
            }
          }
        }, 25);
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

      const { sessionId, cmd, payload } = decode(buf);

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
          let opts = { cmd: [DEFAULT_SHELL], cols: 80, rows: 24 };

          if (payload.length > 0) {
            try {
              const parsed = JSON.parse(payload.toString());
              requestId = parsed.requestId;
              if (Array.isArray(parsed.cmd)) opts.cmd = parsed.cmd;
              if (Number.isInteger(parsed.cols) && parsed.cols > 0) opts.cols = parsed.cols;
              if (Number.isInteger(parsed.rows) && parsed.rows > 0) opts.rows = parsed.rows;
            } catch {
              safeSend(ws, encode(0, CMD.CREATE, jsonPayload({ requestId, ok: false, error: 'invalid payload' })));
              break;
            }
          }

          manager.create(opts.cmd, opts.cols, opts.rows).then((session) => {
            log(`CREATE session=${session.id} pid=${session.pid} cmd=${opts.cmd.join(' ')}`);
            safeSend(ws, encode(session.id, CMD.CREATE, jsonPayload({ requestId, ok: true })));
            wireSession(session.id);
            // Send initial snapshot (holder may have buffered output before viewer was added)
            const snap = session.snapshot();
            if (snap.length > 0) {
              safeSend(ws, encode(session.id, CMD.SNAPSHOT, Buffer.from(snap)));
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

          if (fromSeq > 0 && session.ring.canReplaySince(fromSeq)) {
            const chunks = session.ring.since(fromSeq);
            for (const chunk of chunks) {
              safeSend(ws, encodeData(sessionId, chunk.seq, chunk.data));
            }
          } else {
            safeSend(ws, encode(sessionId, CMD.SNAPSHOT, Buffer.from(session.snapshot())));
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
            safeSend(ws, encode(sessionId, CMD.SNAPSHOT, Buffer.from(session.snapshot())));
          }
          break;
        }

        case CMD.ACK: {
          const ackMeta = parseJson<{ seq: number }>(payload);
          if (ackMeta?.seq) {
            updateViewerAck(viewerId, sessionId, ackMeta.seq);
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
            if (fromSeq > 0 && session.ring.canReplaySince(fromSeq)) {
              const chunks = session.ring.since(fromSeq);
              for (const chunk of chunks) {
                safeSend(ws, encodeData(sessionId, chunk.seq, chunk.data));
              }
            } else {
              safeSend(ws, encode(sessionId, CMD.SNAPSHOT, Buffer.from(session.snapshot())));
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
              session.write(payload);
            }
          }
          break;
        }

        case CMD.RESIZE:
          if (payload.length >= 4) {
            const cols = payload.readUInt16LE(0);
            const rows = payload.readUInt16LE(2);
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

  await new Promise<void>((resolve) => httpServer.listen(port, resolve));

  return {
    manager,
    agentBus,
    wss,
    httpServer,
    close: async () => {
      fileBridge?.stop?.();
      agentBus?.close?.();
      await manager.shutdown(); // persist + don't kill holders
      await workspaceStore.save(); // persist workspace layouts
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
