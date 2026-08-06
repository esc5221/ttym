import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { createServer, TtymServer } from './server.js';
import { CMD, decode, encode, toBuffer } from './protocol.js';
import { rmSync } from 'node:fs';

type Frame = NonNullable<ReturnType<typeof decode>>;

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
      const frame = decode(toBuffer(raw));
      if (!frame) return;
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

  send(frame: Uint8Array) { this.ws.send(frame); }

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
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
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

  it('forces snapshot on attach when a sync block is still open', async () => {
    const port = (server!.httpServer.address() as AddressInfo).port;
    const ws1 = await openClient(port);
    clients.push(ws1);

    ws1.send(encode(0, CMD.CREATE, Buffer.from(JSON.stringify({
      cmd: ['/bin/sh', '-lc', "printf '\\033[?2026hhello'; sleep 1; printf ' world\\033[?2026l'; stty -echo; exec cat"],
      cols: 80,
      rows: 24,
    }))));

    const created = await ws1.next((f) => f.cmd === CMD.CREATE);
    const sid = created.sessionId;

    // Give the session enough time to enter an open sync block.
    await new Promise((r) => setTimeout(r, 150));

    const ws2 = await openClient(port);
    clients.push(ws2);
    ws2.send(encode(sid, CMD.ATTACH, Buffer.from(JSON.stringify({ fromSeq: 1 }))));

    const attached = await ws2.next((f) => f.cmd === CMD.ATTACH && f.sessionId === sid);
    expect(JSON.parse(attached.payload.toString()).ok).toBe(true);

    const snapshot = await ws2.next((f) => f.cmd === CMD.SNAPSHOT && f.sessionId === sid);
    expect(snapshot.payload.toString()).toContain('hello');
  });

  it('reattaches after a completed sync block without replaying a snapshot-style reset payload', async () => {
    const port = (server!.httpServer.address() as AddressInfo).port;
    const ws1 = await openClient(port);
    clients.push(ws1);

    ws1.send(encode(0, CMD.CREATE, Buffer.from(JSON.stringify({
      cmd: ['/bin/sh', '-lc', "printf '\\033[?2026hhello\\033[31m red\\033[0m\\033[?2026l'; stty -echo; exec cat"],
      cols: 80,
      rows: 24,
    }))));

    const created = await ws1.next((f) => f.cmd === CMD.CREATE);
    const sid = created.sessionId;
    const first = await ws1.next((f) => (f.cmd === CMD.DATA || f.cmd === CMD.SNAPSHOT) && f.sessionId === sid);
    expect([CMD.DATA, CMD.SNAPSHOT]).toContain(first.cmd);
    expect(Buffer.from(first.payload).toString('binary')).toContain('hello');

    ws1.send(encode(sid, CMD.DETACH));
    await ws1.next((f) => f.cmd === CMD.DETACH && f.sessionId === sid);
    await ws1.close();

    const ws2 = await openClient(port);
    clients.push(ws2);
    ws2.send(encode(sid, CMD.ATTACH, Buffer.from(JSON.stringify({ fromSeq: 0, cols: 80, rows: 24 }))));
    await ws2.next((f) => f.cmd === CMD.ATTACH && f.sessionId === sid);
    const replay = await ws2.next((f) => f.cmd === CMD.SNAPSHOT && f.sessionId === sid);
    expect(replay.cmd).toBe(CMD.SNAPSHOT);
    const replayText = Buffer.from(replay.payload).toString('binary');
    expect(replayText).toContain('hello');
    expect(replayText).not.toContain('\x1bc');
    expect(replayText).not.toContain('\x1b[?2026h');
    expect(replayText).not.toContain('\x1b[?2026l');
  });

  it('atomically splits a workspace by creating a session and inserting it to the right', async () => {
    const port = (server!.httpServer.address() as AddressInfo).port;

    const createWorkspaceRes = await fetch(`http://127.0.0.1:${port}/api/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'split-test',
        project: 'default',
        name: 'workspace split test',
        layout: { type: 'pane', sessionId: 0 },
      }),
    });
    expect(createWorkspaceRes.status).toBe(201);

    const splitRes1 = await fetch(`http://127.0.0.1:${port}/api/workspaces/split-test/split`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cols: 80, rows: 24, name: 'lead', cwd: '/tmp' }),
    });
    expect(splitRes1.status).toBe(201);
    const split1 = await splitRes1.json();
    expect(split1.workspace.members.map((member: any) => member.name)).toEqual(['lead']);
    const firstSessionId = split1.session.id;

    const splitRes2 = await fetch(`http://127.0.0.1:${port}/api/workspaces/split-test/split`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetSessionId: firstSessionId, cols: 80, rows: 24, name: 'worker' }),
    });
    expect(splitRes2.status).toBe(201);
    const split2 = await splitRes2.json();
    expect(split2.workspace.layout).toEqual({
      type: 'split',
      axis: 'row',
      sizes: [0.5, 0.5],
      children: [
        { type: 'pane', sessionId: firstSessionId },
        { type: 'pane', sessionId: split2.session.id },
      ],
    });
    expect(split2.workspace.members.map((member: any) => member.name)).toEqual(['lead', 'worker']);

    const sessionRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${split2.session.id}`);
    expect(sessionRes.status).toBe(200);
  });
});

describe('meta ownership over HTTP', () => {
  let server: TtymServer | null = null;
  const runtimeDir = `/tmp/ttym-meta-test-${process.pid}`;

  beforeEach(async () => {
    process.env.TTYM_RUNTIME_DIR = runtimeDir;
    server = await createServer(0);
  });

  afterEach(async () => {
    if (server) {
      server.manager.destroyAll();
      await server.close();
    }
    server = null;
    await new Promise((r) => setTimeout(r, 200));
    try { rmSync(runtimeDir, { recursive: true }); } catch {}
    delete process.env.TTYM_RUNTIME_DIR;
  });

  async function createSession(port: number): Promise<number> {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: ['/bin/sh', '-lc', 'stty -echo; exec cat'], cols: 80, rows: 24 }),
    });
    return (await res.json()).id;
  }

  it('refuses runtime keys on the public surface, and names them', async () => {
    const port = (server!.httpServer.address() as AddressInfo).port;
    const id = await createSession(port);

    const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${id}/meta`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claudeSessionId: 'spoofed', note: 'fine' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('claudeSessionId');

    // The write must not have landed, not even the harmless part of it.
    const meta = await (await fetch(`http://127.0.0.1:${port}/api/sessions/${id}/meta`)).json();
    expect(meta.claudeSessionId).toBeUndefined();
    expect(meta.note).toBeUndefined();
  });

  it('lets hooks write the same keys through the internal path', async () => {
    const port = (server!.httpServer.address() as AddressInfo).port;
    const id = await createSession(port);

    const res = await fetch(`http://127.0.0.1:${port}/api/internal/sessions/${id}/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claudeSessionId: 'real', claudeActive: true }),
    });
    expect(res.status).toBe(200);

    const meta = await (await fetch(`http://127.0.0.1:${port}/api/sessions/${id}/meta`)).json();
    expect(meta.claudeSessionId).toBe('real');

    // And the internal path takes nothing but runtime keys.
    const mixed = await fetch(`http://127.0.0.1:${port}/api/internal/sessions/${id}/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claudeSessionId: 'x', note: 'smuggled' }),
    });
    expect(mixed.status).toBe(400);
  });

  it('assembles the runtime view and keeps it read-only by construction', async () => {
    const port = (server!.httpServer.address() as AddressInfo).port;
    const id = await createSession(port);

    // Agent mapping arrives the way it does in production: through the hook path.
    await fetch(`http://127.0.0.1:${port}/api/internal/sessions/${id}/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claudeSessionId: 'cs-1', claudeActive: true }),
    });

    const rt = await (await fetch(`http://127.0.0.1:${port}/api/sessions/${id}/runtime`)).json();
    expect(rt.terminal.cols).toBe(80);
    expect(rt.process.state).toBe('running');
    expect(rt.process.pid).toBeGreaterThan(0);
    expect(rt.agent.kind).toBe('claude-code');
    expect(rt.agent.externalSessionId).toBe('cs-1');
    expect(rt.agent.activeInteractionId).toBeNull();

    // There is no write method on /runtime at all.
    const write = await fetch(`http://127.0.0.1:${port}/api/sessions/${id}/runtime`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminal: { cols: 999 } }),
    });
    expect(write.status).toBe(404);
  });

  it('serves annotations without the server-owned keys mixed in', async () => {
    const port = (server!.httpServer.address() as AddressInfo).port;
    const id = await createSession(port);

    await fetch(`http://127.0.0.1:${port}/api/internal/sessions/${id}/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claudeSessionId: 'cs-2' }),
    });
    const patched = await fetch(`http://127.0.0.1:${port}/api/sessions/${id}/annotations`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket: 'TT-9' }),
    });
    expect(patched.status).toBe(200);

    const ann = await patched.json();
    expect(ann.ticket).toBe('TT-9');
    expect(ann.claudeSessionId).toBeUndefined(); // runtime never leaks into this view

    // The compat surface still shows everything merged.
    const meta = await (await fetch(`http://127.0.0.1:${port}/api/sessions/${id}/meta`)).json();
    expect(meta.ticket).toBe('TT-9');
    expect(meta.claudeSessionId).toBe('cs-2');

    // And the new surface refuses runtime keys just like the old one.
    const bad = await fetch(`http://127.0.0.1:${port}/api/sessions/${id}/annotations`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stopSeq: '1' }),
    });
    expect(bad.status).toBe(400);
  });

  it('annotations cannot stall an await — the C acceptance test', async () => {
    const port = (server!.httpServer.address() as AddressInfo).port;
    const id = await createSession(port);

    // Write arbitrary user keys, including names that once meant protocol state
    // to older clients but are spelled differently.
    const note = await fetch(`http://127.0.0.1:${port}/api/sessions/${id}/meta`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket: 'TT-142', owner: 'lullu', sequence: '0' }),
    });
    expect(note.status).toBe(200);

    // The interaction round trip still settles.
    const submitted = fetch(`http://127.0.0.1:${port}/api/sessions/${id}/interactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'ping', timeoutMs: 8000, submit: 'lf' }),
    }).then((r) => r.json());

    await new Promise((r) => setTimeout(r, 300));
    await fetch(`http://127.0.0.1:${port}/api/internal/sessions/${id}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'Stop' }),
    });

    const result = await submitted;
    expect(result.interaction.status).toBe('completed');
    expect(result.interaction.transcript).toContain('ping');
  }, 15_000);
});
