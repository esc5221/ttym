import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { createServer, TtymServer } from './server.js';
import { CMD, decodeDataFrame, encode, toBuffer } from './protocol.js';
import { rmSync } from 'node:fs';

type Frame = ReturnType<typeof decodeDataFrame>;

class TestClient {
  private readonly frames: Frame[] = [];
  private readonly waiters: Array<{
    predicate: (frame: Frame) => boolean;
    resolve: (frame: Frame) => void;
    reject: (error: Error) => void;
    timeoutId: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(readonly ws: WebSocket) {
    this.ws.on('message', (raw) => {
      const frame = decodeDataFrame(toBuffer(raw));
      const waiterIndex = this.waiters.findIndex((waiter) => waiter.predicate(frame));
      if (waiterIndex !== -1) {
        const waiter = this.waiters.splice(waiterIndex, 1)[0]!;
        clearTimeout(waiter.timeoutId);
        waiter.resolve(frame);
        return;
      }
      this.frames.push(frame);
    });
  }

  send(frame: Buffer) { this.ws.send(frame); }

  next(predicate: (frame: Frame) => boolean, timeoutMs = 10_000): Promise<Frame> {
    const existingIndex = this.frames.findIndex(predicate);
    if (existingIndex !== -1) {
      return Promise.resolve(this.frames.splice(existingIndex, 1)[0]!);
    }
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(new Error('Timed out waiting for frame'));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, reject, timeoutId });
    });
  }

  async close() {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }
}

async function openClient(port: number): Promise<TestClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return new TestClient(ws);
}

describe('createServer', () => {
  let server: TtymServer | null = null;
  let clients: TestClient[] = [];
  const runtimeDir = `/tmp/ttym-srv-test-${process.pid}`;

  beforeEach(async () => {
    process.env.TTYM_RUNTIME_DIR = runtimeDir;
    server = await createServer(0);
  });

  afterEach(async () => {
    while (clients.length > 0) {
      await clients.pop()!.close();
    }
    if (server) {
      server.manager.destroyAll();
      await server.close();
    }
    server = null;
    await new Promise((r) => setTimeout(r, 200));
    try { rmSync(runtimeDir, { recursive: true }); } catch {}
    delete process.env.TTYM_RUNTIME_DIR;
  });

  it('returns error and cleans up when verify detects early exit', async () => {
    const port = (server!.httpServer.address() as AddressInfo).port;

    // Create session with invalid command and verify: true
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: ['__nonexistent_command_xyz__'], cols: 80, rows: 24, verify: true }),
    });

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain('exited immediately');

    // Verify session was cleaned up
    const listRes = await fetch(`http://127.0.0.1:${port}/api/sessions`);
    const sessions = await listRes.json();
    const found = sessions.find((s: any) => s.id === body.sessionId);
    expect(found).toBeUndefined();
  });

  it('creates session and attaches with snapshot', async () => {
    const port = (server!.httpServer.address() as AddressInfo).port;
    const ws1 = await openClient(port);
    clients.push(ws1);

    ws1.send(encode(0, CMD.CREATE, Buffer.from(JSON.stringify({
      cmd: ['/bin/sh', '-lc', "printf 'hello\\n'; stty -echo; exec cat"],
      cols: 80, rows: 24,
    }))));

    const created = await ws1.next((f) => f.cmd === CMD.CREATE);
    const sid = created.sessionId;
    // Wait for initial output — may arrive as DATA or SNAPSHOT (holder catches up via DUMP)
    await ws1.next((f) => (f.cmd === CMD.DATA || f.cmd === CMD.SNAPSHOT) && f.sessionId === sid);

    // Detach and reattach
    ws1.send(encode(sid, CMD.DETACH));
    await ws1.next((f) => f.cmd === CMD.DETACH && f.sessionId === sid);
    await ws1.close();

    const ws2 = await openClient(port);
    clients.push(ws2);
    ws2.send(encode(sid, CMD.ATTACH, Buffer.from(JSON.stringify({ fromSeq: 0, cols: 80, rows: 24 }))));

    const attached = await ws2.next((f) => f.cmd === CMD.ATTACH && f.sessionId === sid);
    expect(JSON.parse(attached.payload.toString()).ok).toBe(true);

    const snapshot = await ws2.next((f) => f.cmd === CMD.SNAPSHOT && f.sessionId === sid);
    expect(snapshot.payload.toString()).toContain('hello');
  });
});
