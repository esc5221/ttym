import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { createServer } from './server.js';
import { CMD, decodeDataFrame, encode, toBuffer } from './protocol.js';

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

  send(frame: Buffer) {
    this.ws.send(frame);
  }

  next(predicate: (frame: Frame) => boolean, timeoutMs = 5_000): Promise<Frame> {
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

function waitForCondition(check: () => boolean, timeoutMs = 5_000, intervalMs = 25): Promise<void> {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error('Timed out waiting for condition'));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
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
  let server: ReturnType<typeof createServer> | null = null;
  let clients: TestClient[] = [];

  beforeEach(async () => {
    server = createServer(0);
    if (!server.wss.address()) {
      await new Promise<void>((resolve) => server!.wss.once('listening', () => resolve()));
    }
  });

  afterEach(async () => {
    while (clients.length > 0) {
      await clients.pop()!.close();
    }
    if (server) await server.close();
    server = null;
  });

  it('keeps detached sessions alive and restores them via ATTACH + SNAPSHOT', async () => {
    const port = (server!.wss.address() as AddressInfo).port;
    const ws1 = await openClient(port);
    clients.push(ws1);

    ws1.send(encode(0, CMD.CREATE, Buffer.from(JSON.stringify({
      cmd: ['/bin/sh', '-lc', "printf 'hello\\n'; stty -echo; exec cat"],
      cols: 80,
      rows: 24,
    }))));

    const created = await ws1.next((frame) => frame.cmd === CMD.CREATE);
    const sessionId = created.sessionId;
    await ws1.next((frame) => frame.cmd === CMD.DATA && frame.sessionId === sessionId);

    ws1.send(encode(sessionId, CMD.DETACH));
    await ws1.next((frame) => frame.cmd === CMD.DETACH && frame.sessionId === sessionId);
    await ws1.close();

    const ws2 = await openClient(port);
    clients.push(ws2);
    ws2.send(encode(sessionId, CMD.ATTACH, Buffer.from(JSON.stringify({
      fromSeq: 0,
      cols: 80,
      rows: 24,
    }))));

    const attached = await ws2.next((frame) => frame.cmd === CMD.ATTACH && frame.sessionId === sessionId);
    expect(JSON.parse(attached.payload.toString()).ok).toBe(true);

    const snapshot = await ws2.next((frame) => frame.cmd === CMD.SNAPSHOT && frame.sessionId === sessionId);
    expect(snapshot.payload.toString()).toContain('hello');
  });

  it('replays buffered output on RESUME_VIEW when fromSeq is available', async () => {
    const port = (server!.wss.address() as AddressInfo).port;
    const ws = await openClient(port);
    clients.push(ws);

    ws.send(encode(0, CMD.CREATE, Buffer.from(JSON.stringify({
      cmd: ['/bin/sh', '-lc', "printf 'ready\\n'; stty -echo; exec cat"],
      cols: 80,
      rows: 24,
    }))));

    const created = await ws.next((frame) => frame.cmd === CMD.CREATE);
    const sessionId = created.sessionId;
    const initialData = await ws.next((frame) => frame.cmd === CMD.DATA && frame.sessionId === sessionId);
    const firstSeq = initialData.seq!;

    ws.send(encode(sessionId, CMD.PAUSE_VIEW));
    ws.send(encode(sessionId, CMD.DATA, Buffer.from('XYZ\n')));

    await waitForCondition(() => {
      const session = server!.manager.get(sessionId);
      return Boolean(session && session.ring.nextSeq - 1 > firstSeq);
    });

    ws.send(encode(sessionId, CMD.RESUME_VIEW, Buffer.from(JSON.stringify({ fromSeq: firstSeq }))));

    let replay = '';
    while (!replay.includes('XYZ')) {
      const frame = await ws.next((candidate) => candidate.cmd === CMD.DATA && candidate.sessionId === sessionId && (candidate.seq ?? 0) > firstSeq);
      replay += frame.payload.toString();
    }

    expect(replay).toContain('XYZ');
  });
});
