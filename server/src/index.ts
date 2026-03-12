import { WebSocketServer, WebSocket } from 'ws';
import { SessionManager } from './session-manager.js';
import { CMD, encode, decode, toBuffer } from './protocol.js';

const PORT = parseInt(process.env.PORT || '7690', 10);
const DEFAULT_SHELL = process.env.SHELL || '/bin/bash';

// 배치/backpressure 상수
const BATCH_MS = 16;
const MAX_BATCH_BYTES = 64 * 1024;
const WS_HIGH_WATER = 1 << 20;  // 1MB
const WS_LOW_WATER = 1 << 18;   // 256KB

const DEBUG = true;
const log = (...args: unknown[]) => DEBUG && console.log(`[srv ${new Date().toISOString().slice(11,23)}]`, ...args);

const manager = new SessionManager();
const wss = new WebSocketServer({ port: PORT });

function safeSend(ws: WebSocket, data: Buffer): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  try { ws.send(data); return true; } catch { return false; }
}

wss.on('connection', (ws: WebSocket) => {
  const clientSessions = new Set<number>();

  ws.on('message', (raw) => {
    const buf = toBuffer(raw);
    if (buf.length < 3) return;

    const { sessionId, cmd, payload } = decode(buf);

    switch (cmd) {
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
            safeSend(ws, encode(0, CMD.CREATE, Buffer.from(
              JSON.stringify({ requestId, ok: false, error: 'invalid payload' })
            )));
            break;
          }
        }

        let session;
        try {
          session = manager.create(opts.cmd, opts.cols, opts.rows);
        } catch (e) {
          console.error('Failed to create session:', e);
          safeSend(ws, encode(0, CMD.CREATE, Buffer.from(
            JSON.stringify({ requestId, ok: false, error: 'spawn failed' })
          )));
          break;
        }

        clientSessions.add(session.id);
        log(`CREATE session=${session.id} pid=${session.pid} cmd=${opts.cmd.join(' ')}`);
        safeSend(ws, encode(session.id, CMD.CREATE, Buffer.from(
          JSON.stringify({ requestId, ok: true })
        )));

        // --- 16ms 배치 + backpressure ---
        let pending: Buffer[] = [];
        let pendingBytes = 0;
        let timer: NodeJS.Timeout | null = null;
        let pausedForBackpressure = false;
        let drainTimer: NodeJS.Timeout | null = null;

        const flush = () => {
          timer = null;
          if (pendingBytes === 0 || ws.readyState !== WebSocket.OPEN) return;

          const frame = Buffer.allocUnsafe(3 + pendingBytes);
          frame.writeUInt16LE(session.id, 0);
          frame[2] = CMD.DATA;
          let offset = 3;
          for (const chunk of pending) { chunk.copy(frame, offset); offset += chunk.length; }
          pending = [];
          pendingBytes = 0;

          safeSend(ws, frame);

          // ws backpressure 체크
          if (!pausedForBackpressure && ws.bufferedAmount > WS_HIGH_WATER) {
            pausedForBackpressure = true;
            session.pause();
            drainTimer = setInterval(() => {
              if (ws.readyState !== WebSocket.OPEN) {
                clearInterval(drainTimer!); drainTimer = null; return;
              }
              if (ws.bufferedAmount <= WS_LOW_WATER) {
                pausedForBackpressure = false;
                clearInterval(drainTimer!); drainTimer = null;
                session.resume();
              }
            }, 25);
          }
        };

        session.onData((data) => {
          pending.push(data);
          pendingBytes += data.length;

          if (pendingBytes >= MAX_BATCH_BYTES) {
            if (timer) { clearTimeout(timer); timer = null; }
            flush();
            return;
          }
          if (!timer) timer = setTimeout(flush, BATCH_MS);
        });

        session.onExit((code) => {
          log(`EXIT session=${session.id} code=${code}`);
          if (timer) { clearTimeout(timer); timer = null; }
          if (drainTimer) { clearInterval(drainTimer); drainTimer = null; }
          flush(); // 남은 데이터 전송
          clientSessions.delete(session.id);
          const sent = safeSend(ws, encode(session.id, CMD.DESTROY));
          log(`DESTROY sent session=${session.id} ok=${sent}`);
        });
        break;
      }

      case CMD.DATA:
        manager.get(sessionId)?.write(payload);
        break;

      case CMD.RESIZE:
        if (payload.length >= 4) {
          const cols = payload.readUInt16LE(0);
          const rows = payload.readUInt16LE(2);
          if (cols > 0 && rows > 0) manager.get(sessionId)?.resize(cols, rows);
        }
        break;

      case CMD.DESTROY:
        manager.destroy(sessionId);
        clientSessions.delete(sessionId);
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
    for (const id of clientSessions) manager.destroy(id);
    clientSessions.clear();
  });
});

console.log(`ttym server listening on ws://localhost:${PORT}`);

const shutdown = () => { manager.destroyAll(); wss.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
