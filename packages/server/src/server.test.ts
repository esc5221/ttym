import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { createServer, agentIsActive, AGENT_ACTIVE_TTL_MS, TtymServer } from './server.js';
import { CMD, decode, encode, toBuffer } from './protocol.js';
import { rmSync, readFileSync, writeFileSync } from 'node:fs';

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

  next(predicate: (frame: Frame) => boolean, timeoutMs = 20_000): Promise<Frame> {
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
    // Config lives under the home dir — without this a config PATCH test
    // would write straight into the developer's real ~/.ttym/config.
    process.env.TTYM_HOME = runtimeDir;
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
    delete process.env.TTYM_HOME;
  });

  it('a rival server never steals sessions a live server owns', async () => {
    // 2026-08-13 dev 사고의 재현: 서버 A가 세션·holder를 쥐고 있는데 같은
    // 런타임으로 서버 B가 부팅하면 — lease는 거절되고(recoverOne), 그 부재를
    // workspace 복원이 '사망'으로 읽어 같은 id로 사칭 holder를 소환했었다.
    const port = (server!.httpServer.address() as AddressInfo).port;
    const wsRes = await fetch(`http://127.0.0.1:${port}/api/workspaces`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'rival', name: 'w' }),
    });
    const wsId = (await wsRes.json()).id;
    const created = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: ['/bin/sh', '-lc', 'stty -echo; exec cat'], cols: 80, rows: 24 }),
    });
    const sid = (await created.json()).id as number;
    await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}/members`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: sid, name: 'victim' }),
    });
    const manifestPath = `${runtimeDir}/session-${sid}.json`;
    const before = JSON.parse(readFileSync(manifestPath, 'utf8'));

    // 부활 미끼: 복원 경로가 읽을 스냅샷을 심는다
    writeFileSync(`${runtimeDir}/snapshot-${sid}.json`, JSON.stringify({
      version: 1, id: sid, cmd: ['/bin/sh'], cols: 80, rows: 24,
      createdAt: Date.now(), savedAt: Date.now(), screen: '', meta: {},
    }));

    const rival = await createServer(0);
    try {
      // 강탈 금지의 증명 세 겹: 라이벌은 그 세션을 모르고, manifest의
      // holder는 그대로이며, A의 세션은 여전히 살아 동작한다.
      expect(rival.manager.get(sid)).toBeUndefined();
      const after = JSON.parse(readFileSync(manifestPath, 'utf8'));
      expect(after.pid).toBe(before.pid);
      expect(after.socket).toBe(before.socket);
    } finally {
      await rival.close();
    }
    const alive = await fetch(`http://127.0.0.1:${port}/api/sessions/${sid}/screen`);
    expect(alive.status).toBe(200);
  }, 30_000);

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

  it('pauses an acking viewer that stops digesting, resumes on ack', async () => {
    const port = (server!.httpServer.address() as AddressInfo).port;
    const ws1 = await openClient(port);
    clients.push(ws1);

    // READY first, then after a beat the shell emits ~400KB on its own —
    // input through the PTY would die at canonical mode's 4KB line limit.
    ws1.send(encode(0, CMD.CREATE, Buffer.from(JSON.stringify({
      cmd: ['/bin/sh', '-lc', "printf 'READY\\n'; sleep 0.5; dd if=/dev/zero bs=1024 count=400 2>/dev/null | tr '\\0' 'x'; stty -echo; exec cat"],
      cols: 80, rows: 24,
    }))));
    const created = await ws1.next((f) => f.cmd === CMD.CREATE);
    const sid = created.sessionId;
    const first = await ws1.next((f) => (f.cmd === CMD.DATA || f.cmd === CMD.SNAPSHOT) && f.sessionId === sid);

    // One ack inside the quiet window opts this viewer into ack accounting.
    const firstSeq = first.seq ?? 1;
    ws1.send(encode(sid, CMD.ACK, Buffer.from(JSON.stringify({ seq: firstSeq }))));

    // Collect until the stream stalls: with a 256KB unacked ceiling the
    // server must stop fanning out well before the full 384KB arrives.
    let received = 0;
    let lastSeq = firstSeq;
    for (;;) {
      try {
        const frame = await ws1.next((f) => f.cmd === CMD.DATA && f.sessionId === sid, 700);
        received += frame.payload.length;
        if (frame.seq !== undefined) lastSeq = frame.seq;
      } catch { break; }
    }
    expect(received).toBeGreaterThan(0);
    expect(received).toBeLessThan(400 * 1024);

    // Digest everything: the server resumes and replays the gap (delta from
    // the ring, or one watermarked snapshot).
    ws1.send(encode(sid, CMD.ACK, Buffer.from(JSON.stringify({ seq: lastSeq }))));
    const resumed = await ws1.next(
      (f) => (f.cmd === CMD.DATA || f.cmd === CMD.SNAPSHOT) && f.sessionId === sid, 10_000);
    expect([CMD.DATA, CMD.SNAPSHOT]).toContain(resumed.cmd);
  }, 30_000);

  it('spawns sessions with parent-agent markers scrubbed and TTYM_PORT stamped', async () => {
    const port = (server!.httpServer.address() as AddressInfo).port;
    // The failure mode: a server started inside a Claude Bash tool fossilizes
    // these and every pane inherits them — transcripts silently stop saving.
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_CHILD_SESSION = '1';
    process.env.CLAUDE_JOB_DIR = '/tmp/jobs/fossil';
    try {
      const ws1 = await openClient(port);
      clients.push(ws1);
      ws1.send(encode(0, CMD.CREATE, Buffer.from(JSON.stringify({
        cmd: ['/bin/sh', '-lc',
          'echo "MARK=${CLAUDECODE:-none}/${CLAUDE_CODE_CHILD_SESSION:-none}/${CLAUDE_JOB_DIR:-none} PORT=$TTYM_PORT"; stty -echo; exec cat'],
        cols: 100, rows: 24,
      }))));
      const created = await ws1.next((f) => f.cmd === CMD.CREATE);
      const sid = created.sessionId;

      let text = '';
      for (;;) {
        const frame = await ws1.next((f) => (f.cmd === CMD.DATA || f.cmd === CMD.SNAPSHOT) && f.sessionId === sid, 10_000);
        text += Buffer.from(frame.payload).toString();
        if (text.includes('PORT=')) break;
      }
      expect(text).toContain('MARK=none/none/none');
      expect(text).toContain(`PORT=${port}`);
    } finally {
      delete process.env.CLAUDECODE;
      delete process.env.CLAUDE_CODE_CHILD_SESSION;
      delete process.env.CLAUDE_JOB_DIR;
    }
  });

  it('serves the config file and pushes patches to every client', async () => {
    const port = (server!.httpServer.address() as AddressInfo).port;
    const ws1 = await openClient(port);
    clients.push(ws1);

    const initial = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json();
    expect(initial.values).toBeDefined();

    const res = await fetch(`http://127.0.0.1:${port}/api/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ theme: 'light', 'font-size': '15' }),
    });
    expect(res.status).toBe(200);

    const evt = await ws1.next((f) => f.cmd === CMD.CONFIG);
    const pushed = JSON.parse(Buffer.from(evt.payload).toString());
    expect(pushed.values.theme).toBe('light');
    expect(pushed.values['font-size']).toBe('15');

    const readBack = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json();
    expect(readBack.values.theme).toBe('light');
  });

  it('pushes agent state to WS clients when a hook writes it', async () => {
    const port = (server!.httpServer.address() as AddressInfo).port;
    const ws1 = await openClient(port);
    clients.push(ws1);

    ws1.send(encode(0, CMD.CREATE, Buffer.from(JSON.stringify({
      cmd: ['/bin/sh', '-lc', 'stty -echo; exec cat'], cols: 80, rows: 24,
    }))));
    const created = await ws1.next((f) => f.cmd === CMD.CREATE);
    const sid = created.sessionId;

    const res = await fetch(`http://127.0.0.1:${port}/api/internal/sessions/${sid}/agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claudeSessionId: 'abc-123', claudeActive: true }),
    });
    expect(res.status).toBe(200);

    const evt = await ws1.next((f) => f.cmd === CMD.AGENT);
    const agent = JSON.parse(Buffer.from(evt.payload).toString());
    expect(agent.sessionId).toBe(sid);
    expect(agent.kind).toBe('claude-code');
    expect(agent.active).toBe(true);
  });

  it('pushes workspace changes to every WS client — full tree, with a generation', async () => {
    const port = (server!.httpServer.address() as AddressInfo).port;
    const ws1 = await openClient(port);
    clients.push(ws1);

    const res = await fetch(`http://127.0.0.1:${port}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'push-ws', project: 'e2e', name: 'push', layout: { type: 'pane', sessionId: 0 }, members: [] }),
    });
    expect(res.status).toBe(201);

    const createdEvt = await ws1.next((f) => f.cmd === CMD.WORKSPACE);
    const created = JSON.parse(Buffer.from(createdEvt.payload).toString());
    expect(created.workspace.id).toBe('push-ws');
    expect(typeof created.generation).toBe('number');

    await fetch(`http://127.0.0.1:${port}/api/workspaces/push-ws`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'renamed' }),
    });
    const updatedEvt = await ws1.next((f) => f.cmd === CMD.WORKSPACE);
    const updated = JSON.parse(Buffer.from(updatedEvt.payload).toString());
    expect(updated.workspace.name).toBe('renamed');
    expect(updated.workspace.layout).toBeDefined();
    expect(updated.generation).toBeGreaterThan(created.generation);

    await fetch(`http://127.0.0.1:${port}/api/workspaces/push-ws`, { method: 'DELETE' });
    const deletedEvt = await ws1.next((f) => f.cmd === CMD.WORKSPACE
      && JSON.parse(Buffer.from(f.payload).toString()).deletedId === 'push-ws');
    expect(JSON.parse(Buffer.from(deletedEvt.payload).toString()).deletedId).toBe('push-ws');
  });

  it('falls back to snapshot when fromSeq is ahead of the session (stale watermark from a previous boot)', async () => {
    const port = (server!.httpServer.address() as AddressInfo).port;
    const ws1 = await openClient(port);
    clients.push(ws1);

    ws1.send(encode(0, CMD.CREATE, Buffer.from(JSON.stringify({
      cmd: ['/bin/sh', '-lc', "printf 'FUTURE-BASE\\n'; stty -echo; exec cat"],
      cols: 80, rows: 24,
    }))));
    const created = await ws1.next((f) => f.cmd === CMD.CREATE);
    const sid = created.sessionId;
    await ws1.next((f) => (f.cmd === CMD.DATA || f.cmd === CMD.SNAPSHOT) && f.sessionId === sid);
    await ws1.close();

    // 서버 재시작 후 seq는 1부터 다시 시작하는데 클라이언트 장부는 이전
    // 부팅의 큰 seq를 들고 온다. canReplaySince는 미래 seq에 true를 주고
    // since()는 빈 배열이라, 가드가 없으면 아무것도 안 보내 빈 화면이 된다.
    const ws2 = await openClient(port);
    clients.push(ws2);
    ws2.send(encode(sid, CMD.ATTACH, Buffer.from(JSON.stringify({ fromSeq: 1_000_000, cols: 80, rows: 24 }))));
    await ws2.next((f) => f.cmd === CMD.ATTACH && f.sessionId === sid);

    const resync = await ws2.next((f) => f.cmd === CMD.SNAPSHOT && f.sessionId === sid);
    expect(resync.payload.toString()).toContain('FUTURE-BASE');
  });

  it('falls back to snapshot when the delta owed is larger than the replay cap', async () => {
    const port = (server!.httpServer.address() as AddressInfo).port;
    const ws1 = await openClient(port);
    clients.push(ws1);

    // sleep 간격이 chunk 경계를 만든다 — 한 번에 뿜으면 holder가 한 chunk로
    // 합쳐버려 "옛 워터마크가 대량 chunk를 빚진" 프로덕션 모양이 안 나온다.
    // 40 × 2KB = 80KB > 상한 64KB.
    ws1.send(encode(0, CMD.CREATE, Buffer.from(JSON.stringify({
      cmd: ['/bin/sh', '-lc',
        'i=0; while [ $i -lt 40 ]; do printf "%2048s" x; sleep 0.02; i=$((i+1)); done; printf "CHUNK-END"; stty -echo; exec cat'],
      cols: 80, rows: 24,
    }))));
    const created = await ws1.next((f) => f.cmd === CMD.CREATE);
    const sid = created.sessionId;
    await ws1.next((f) => (f.cmd === CMD.DATA || f.cmd === CMD.SNAPSHOT)
      && f.sessionId === sid && Buffer.from(f.payload).toString('binary').includes('CHUNK-END'));
    await ws1.close();

    // 오래 가려져 있던 pane의 옛 워터마크: ring이 커버하더라도 대량 raw
    // ANSI 재생 대신 캡된 스냅샷 한 방이어야 한다.
    const ws2 = await openClient(port);
    clients.push(ws2);
    ws2.send(encode(sid, CMD.ATTACH, Buffer.from(JSON.stringify({ fromSeq: 1, cols: 80, rows: 24 }))));
    await ws2.next((f) => f.cmd === CMD.ATTACH && f.sessionId === sid);

    const resync = await ws2.next((f) => (f.cmd === CMD.SNAPSHOT || f.cmd === CMD.DATA) && f.sessionId === sid);
    expect(resync.cmd).toBe(CMD.SNAPSHOT);
  }, 30_000);

  it('exposes screen integrity on the runtime view', async () => {
    const port = (server!.httpServer.address() as AddressInfo).port;
    const ws1 = await openClient(port);
    clients.push(ws1);
    ws1.send(encode(0, CMD.CREATE, Buffer.from(JSON.stringify({
      cmd: ['/bin/sh', '-lc', 'stty -echo; exec cat'], cols: 80, rows: 24,
    }))));
    const created = await ws1.next((f) => f.cmd === CMD.CREATE);
    const runtime = await (await fetch(`http://127.0.0.1:${port}/api/sessions/${created.sessionId}/runtime`)).json() as {
      terminal: { integrity: string };
    };
    expect(runtime.terminal.integrity).toBe('healthy');
  });

  it('accepts a dropped file upload and dedupes names Finder-style', async () => {
    const port = (server!.httpServer.address() as AddressInfo).port;
    const put = (name: string, body: string) =>
      fetch(`http://127.0.0.1:${port}/api/upload?name=${encodeURIComponent(name)}`, {
        method: 'POST', body,
      }).then(async (r) => ({ status: r.status, json: await r.json() as { path?: string; name?: string; error?: string } }));

    const first = await put('note.txt', 'ONE');
    expect(first.status).toBe(201);
    expect(first.json.name).toBe('note.txt');
    expect(readFileSync(first.json.path!, 'utf8')).toBe('ONE');

    // 같은 이름 재드롭: 덮어쓰기 금지 — 앞서 준 경로의 내용이 대화 중간에
    // 바뀌는 건 조용한 오염이다. Finder식 -2로 비켜간다.
    const second = await put('note.txt', 'TWO');
    expect(second.json.name).toBe('note-2.txt');
    expect(readFileSync(first.json.path!, 'utf8')).toBe('ONE');
    expect(readFileSync(second.json.path!, 'utf8')).toBe('TWO');

    // 경로 성분은 신뢰하지 않는다.
    const sneaky = await put('../../evil.sh', 'X');
    expect(sneaky.status).toBe(201);
    expect(sneaky.json.name).toBe('evil.sh');
    expect(sneaky.json.path!.includes('..')).toBe(false);
  });

  it('a paused-then-reattached viewer keeps receiving live output', async () => {
    const port = (server!.httpServer.address() as AddressInfo).port;
    const ws1 = await openClient(port);
    clients.push(ws1);

    ws1.send(encode(0, CMD.CREATE, Buffer.from(JSON.stringify({
      cmd: ['/bin/sh', '-lc', 'stty -echo; exec cat'], cols: 80, rows: 24,
    }))));
    const created = await ws1.next((f) => f.cmd === CMD.CREATE);
    const sid = created.sessionId;
    await new Promise((r) => setTimeout(r, 200));

    // PAUSE 후 DETACH 없이 재-ATTACH: batcher가 재사용되는 경로다. 리셋이
    // 없으면 pausedView=true가 살아남아 라이브 출력이 전부 버려지고, 그걸
    // 풀어줄 신호는 영원히 오지 않는다.
    ws1.send(encode(sid, CMD.PAUSE_VIEW));
    await new Promise((r) => setTimeout(r, 50));
    ws1.send(encode(sid, CMD.ATTACH, Buffer.from(JSON.stringify({ fromSeq: 0, cols: 80, rows: 24 }))));
    await ws1.next((f) => f.cmd === CMD.ATTACH && f.sessionId === sid);
    await ws1.next((f) => f.cmd === CMD.SNAPSHOT && f.sessionId === sid);

    ws1.send(encode(sid, CMD.DATA, Buffer.from('LIVE-AFTER-REATTACH\n')));
    const echoed = await ws1.next((f) => f.cmd === CMD.DATA && f.sessionId === sid
      && Buffer.from(f.payload).toString('binary').includes('LIVE-AFTER-REATTACH'));
    expect(echoed.seq).toBeGreaterThan(0);
  });

  it('a bogus future ACK cannot flush the ring for everyone', async () => {
    const port = (server!.httpServer.address() as AddressInfo).port;
    const ws1 = await openClient(port);
    clients.push(ws1);

    ws1.send(encode(0, CMD.CREATE, Buffer.from(JSON.stringify({
      cmd: ['/bin/sh', '-lc', 'stty -echo; exec cat'], cols: 80, rows: 24,
    }))));
    const created = await ws1.next((f) => f.cmd === CMD.CREATE);
    const sid = created.sessionId;
    await new Promise((r) => setTimeout(r, 200));

    ws1.send(encode(sid, CMD.DATA, Buffer.from('CHUNK-A\n')));
    const a = await ws1.next((f) => f.cmd === CMD.DATA && f.sessionId === sid
      && Buffer.from(f.payload).toString('binary').includes('CHUNK-A'));
    ws1.send(encode(sid, CMD.DATA, Buffer.from('CHUNK-B\n')));
    await ws1.next((f) => f.cmd === CMD.DATA && f.sessionId === sid
      && Buffer.from(f.payload).toString('binary').includes('CHUNK-B'));

    // ack은 "여기까지 파싱했다"는 주장이고 ring 절단으로 직결된다 — 받은 적
    // 없는 미래 seq 주장은 기각되어야 한다. 예전엔 이 한 방이 ring을 통째로
    // 비워 다른 모든 viewer의 delta 재생을 파괴했다.
    ws1.send(encode(sid, CMD.ACK, Buffer.from(JSON.stringify({ seq: a.seq! + 10_000_000 }))));
    await new Promise((r) => setTimeout(r, 100));

    const ws2 = await openClient(port);
    clients.push(ws2);
    ws2.send(encode(sid, CMD.ATTACH, Buffer.from(JSON.stringify({ fromSeq: a.seq, cols: 80, rows: 24 }))));
    await ws2.next((f) => f.cmd === CMD.ATTACH && f.sessionId === sid);
    const resync = await ws2.next((f) => (f.cmd === CMD.SNAPSHOT || f.cmd === CMD.DATA) && f.sessionId === sid);
    expect(resync.cmd).toBe(CMD.DATA);
    expect(Buffer.from(resync.payload).toString('binary')).toContain('CHUNK-B');
  });

  it('DETACH clears the departed viewer ack floor so the ring can trim', async () => {
    const port = (server!.httpServer.address() as AddressInfo).port;
    const ws1 = await openClient(port);
    clients.push(ws1);

    ws1.send(encode(0, CMD.CREATE, Buffer.from(JSON.stringify({
      cmd: ['/bin/sh', '-lc', 'stty -echo; exec cat'], cols: 80, rows: 24,
    }))));
    const created = await ws1.next((f) => f.cmd === CMD.CREATE);
    const sid = created.sessionId;
    await new Promise((r) => setTimeout(r, 200));

    ws1.send(encode(sid, CMD.DATA, Buffer.from('ONE\n')));
    const one = await ws1.next((f) => f.cmd === CMD.DATA && f.sessionId === sid
      && Buffer.from(f.payload).toString('binary').includes('ONE'));
    ws1.send(encode(sid, CMD.DATA, Buffer.from('TWO\n')));
    const two = await ws1.next((f) => f.cmd === CMD.DATA && f.sessionId === sid
      && Buffer.from(f.payload).toString('binary').includes('TWO'));

    // ws1은 ONE까지만 소화했다고 주장 → ring은 TWO를 붙들고 있어야 한다.
    ws1.send(encode(sid, CMD.ACK, Buffer.from(JSON.stringify({ seq: one.seq }))));
    await new Promise((r) => setTimeout(r, 100));
    const ring = server!.manager.get(sid)!.ring;
    expect(ring.baseSeq).toBeLessThanOrEqual(two.seq!);

    // ws2가 TWO까지 ack해도 ws1의 낮은 floor가 trim을 막는다.
    const ws2 = await openClient(port);
    clients.push(ws2);
    ws2.send(encode(sid, CMD.ATTACH, Buffer.from(JSON.stringify({ fromSeq: 0, cols: 80, rows: 24 }))));
    await ws2.next((f) => f.cmd === CMD.ATTACH && f.sessionId === sid);
    await ws2.next((f) => f.cmd === CMD.SNAPSHOT && f.sessionId === sid);
    ws2.send(encode(sid, CMD.ACK, Buffer.from(JSON.stringify({ seq: two.seq }))));
    await new Promise((r) => setTimeout(r, 100));
    expect(ring.baseSeq).toBeLessThanOrEqual(two.seq!);

    // ws1이 떠나면 그 floor도 함께 사라져야 ring이 전진한다.
    ws1.send(encode(sid, CMD.DETACH));
    await ws1.next((f) => f.cmd === CMD.DETACH && f.sessionId === sid);
    await new Promise((r) => setTimeout(r, 100));
    expect(ring.baseSeq).toBeGreaterThan(two.seq!);
  });

  it('stamps snapshots with a watermark, and resumeView from it replays delta — not another snapshot', async () => {
    const port = (server!.httpServer.address() as AddressInfo).port;
    const ws1 = await openClient(port);
    clients.push(ws1);

    ws1.send(encode(0, CMD.CREATE, Buffer.from(JSON.stringify({
      cmd: ['/bin/sh', '-lc', "printf 'hello\\n'; stty -echo; exec cat"],
      cols: 80, rows: 24,
    }))));
    const created = await ws1.next((f) => f.cmd === CMD.CREATE);
    const sid = created.sessionId;
    await ws1.next((f) => (f.cmd === CMD.DATA || f.cmd === CMD.SNAPSHOT) && f.sessionId === sid);
    ws1.send(encode(sid, CMD.DETACH));
    await ws1.next((f) => f.cmd === CMD.DETACH && f.sessionId === sid);
    await ws1.close();

    const ws2 = await openClient(port);
    clients.push(ws2);
    ws2.send(encode(sid, CMD.ATTACH, Buffer.from(JSON.stringify({ fromSeq: 0, cols: 80, rows: 24 }))));
    await ws2.next((f) => f.cmd === CMD.ATTACH && f.sessionId === sid);

    // The fresh attach resyncs by snapshot — which must carry the ring seq
    // it was rendered at.
    const snapshot = await ws2.next((f) => f.cmd === CMD.SNAPSHOT && f.sessionId === sid);
    expect(snapshot.seq).toBeDefined();
    expect(snapshot.seq!).toBeGreaterThan(0);

    // Miss some output while the view is paused…
    ws2.send(encode(sid, CMD.PAUSE_VIEW));
    ws2.send(encode(sid, CMD.DATA, Buffer.from('RESYNC-MARK\n')));
    await new Promise((r) => setTimeout(r, 400));

    // …then resume from the snapshot's watermark. A client without the
    // watermark would still send its pre-snapshot fromSeq and be handed a
    // second snapshot; with it, the gap replays as plain DATA.
    ws2.send(encode(sid, CMD.RESUME_VIEW, Buffer.from(JSON.stringify({ fromSeq: snapshot.seq }))));
    const replay = await ws2.next((f) => f.cmd === CMD.DATA && f.sessionId === sid
      && Buffer.from(f.payload).toString('binary').includes('RESYNC-MARK'));
    expect(replay.seq!).toBeGreaterThan(snapshot.seq!);
    await expect(ws2.next((f) => f.cmd === CMD.SNAPSHOT && f.sessionId === sid, 400)).rejects.toThrow();
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

describe('multi-byte input over the wire — the Korean IME regression', () => {
  let server: TtymServer | null = null;
  const clients: TestClient[] = [];
  const runtimeDir = `/tmp/ttym-ime-test-${process.pid}`;

  beforeEach(async () => {
    process.env.TTYM_RUNTIME_DIR = runtimeDir;
    server = await createServer(0);
  });

  afterEach(async () => {
    while (clients.length > 0) await clients.pop()!.close();
    if (server) {
      server.manager.destroyAll();
      await server.close();
    }
    server = null;
    await new Promise((r) => setTimeout(r, 200));
    try { rmSync(runtimeDir, { recursive: true }); } catch {}
    delete process.env.TTYM_RUNTIME_DIR;
  });

  it('a 4-byte IME commit reaches the PTY intact', async () => {
    const port = (server!.httpServer.address() as AddressInfo).port;
    const ws = await openClient(port);
    clients.push(ws);

    ws.send(encode(0, CMD.CREATE, Buffer.from(JSON.stringify({
      cmd: ['/bin/sh', '-lc', "printf 'ready\\n'; stty -echo; exec cat"],
      cols: 80, rows: 24,
    }))));
    const created = await ws.next((f) => f.cmd === CMD.CREATE);
    const sid = created.sessionId;
    ws.send(encode(sid, CMD.ATTACH, Buffer.from(JSON.stringify({ mode: 'readwrite' }))));
    await ws.next((f) => f.cmd === CMD.ATTACH && f.sessionId === sid);

    // '녕 ' — the composition-plus-space commit that used to vanish: 4 bytes
    // of payload put the frame at exactly the old seq threshold.
    // Newline included: the PTY is canonical, so the line discipline holds
    // input back from cat until one arrives. Five bytes — still past the old
    // seq threshold that ate the frame.
    ws.send(encode(sid, CMD.DATA, Buffer.from('녕 \n', 'utf8')));
    const echoed = await ws.next(
      (f) => f.cmd === CMD.DATA && f.sessionId === sid
        && Buffer.from(f.payload).toString('utf8').includes('녕 '),
    );
    expect(Buffer.from(echoed.payload).toString('utf8')).toContain('녕 ');
  });

  it('fast Korean typing reassembles byte-exact through the PTY', async () => {
    const port = (server!.httpServer.address() as AddressInfo).port;
    const ws = await openClient(port);
    clients.push(ws);

    ws.send(encode(0, CMD.CREATE, Buffer.from(JSON.stringify({
      cmd: ['/bin/sh', '-lc', "printf 'ready\\n'; stty -echo; exec cat"],
      cols: 120, rows: 24,
    }))));
    const created = await ws.next((f) => f.cmd === CMD.CREATE);
    const sid = created.sessionId;
    ws.send(encode(sid, CMD.ATTACH, Buffer.from(JSON.stringify({ mode: 'readwrite' }))));
    await ws.next((f) => f.cmd === CMD.ATTACH && f.sessionId === sid);

    // A sentence the way a browser IME actually commits it under fast typing:
    // lone syllables (6-byte frames), word-final syllables committed together
    // with their space (7 bytes — the old seq threshold), ASCII runs. The
    // production symptom was words glued together minus their last syllable:
    // "이거 안좋아하는게 …" arriving as "이안좋아하는들어갔는…".
    const commits = [
      '이', '거 ', '안', '좋', '아', '하', '는', '게 ',
      '들', '어', '갔', '는', '데 ', 'l', 'i', 'n', 't', ' ',
      '안', '걸', '렸', '고 ', '파', '일', '\n',
    ];
    for (const c of commits) {
      ws.send(encode(sid, CMD.DATA, Buffer.from(c, 'utf8')));
    }

    const sentence = '이거 안좋아하는게 들어갔는데 lint 안걸렸고 파일';
    let acc = '';
    while (!acc.includes(sentence)) {
      const f = await ws.next(
        (fr) => fr.cmd === CMD.DATA && fr.sessionId === sid,
      );
      acc += Buffer.from(f.payload).toString('utf8');
    }
    expect(acc).toContain(sentence);
  });

  it('a pasted line keeps its first four bytes', async () => {
    const port = (server!.httpServer.address() as AddressInfo).port;
    const ws = await openClient(port);
    clients.push(ws);

    ws.send(encode(0, CMD.CREATE, Buffer.from(JSON.stringify({
      cmd: ['/bin/sh', '-lc', "printf 'ready\\n'; stty -echo; exec cat"],
      cols: 80, rows: 24,
    }))));
    const created = await ws.next((f) => f.cmd === CMD.CREATE);
    const sid = created.sessionId;
    ws.send(encode(sid, CMD.ATTACH, Buffer.from(JSON.stringify({ mode: 'readwrite' }))));
    await ws.next((f) => f.cmd === CMD.ATTACH && f.sessionId === sid);

    // The unified decode ate 'echo' off the front of exactly this shape —
    // and the earlier probe passed anyway because the shell's error message
    // still contained the marker. Assert the full line survives.
    ws.send(encode(sid, CMD.DATA, Buffer.from('echo full-line-intact\n', 'utf8')));
    const echoed = await ws.next(
      (f) => f.cmd === CMD.DATA && f.sessionId === sid
        && Buffer.from(f.payload).toString('utf8').includes('full-line-intact'),
    );
    expect(Buffer.from(echoed.payload).toString('utf8')).toContain('echo full-line-intact');
  });
});

describe('meta ownership over HTTP', () => {
  let server: TtymServer | null = null;
  const runtimeDir = `/tmp/ttym-meta-test-${process.pid}`;

  beforeEach(async () => {
    process.env.TTYM_RUNTIME_DIR = runtimeDir;
    // TTYM_HOME 미설정이면 getHomeDir()가 진짜 ~/.ttym으로 떨어진다 —
    // map-api-key 테스트가 개발 머신의 실키를 읽고(즉시 red) 최악엔 지운다.
    process.env.TTYM_HOME = runtimeDir;
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
    delete process.env.TTYM_HOME;
  });

  async function createSession(port: number): Promise<number> {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: ['/bin/sh', '-lc', 'stty -echo; exec cat'], cols: 80, rows: 24 }),
    });
    const body = await res.json();
    // Fail here with the server's message rather than three asserts later with
    // a mystery 404 from an /undefined/ URL.
    if (!body?.id) throw new Error(`session create failed: ${res.status} ${JSON.stringify(body)}`);
    return body.id;
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

  it('the work map joins summaries and stays seq-honest about freshness', async () => {
    const port = (server!.httpServer.address() as AddressInfo).port;
    const wsRes = await fetch(`http://127.0.0.1:${port}/api/workspaces`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'map-ws', project: 'map', name: 'mapped', layout: { type: 'pane', sessionId: 0 } }),
    });
    const wsId = (await wsRes.json()).id as string;
    expect(wsId).toBe('map-ws');
    const created = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: ['/bin/sh', '-lc', 'stty -echo; exec cat'], cols: 80, rows: 24 }),
    });
    const sid = (await created.json()).id as number;
    await new Promise((r) => setTimeout(r, 300)); // 초기 프롬프트 출력이 가라앉게

    // 요약이 없는 세션: summary=null이고 stale이다 — 없는 데이터를 지어내지 않는다.
    const map1 = await (await fetch(`http://127.0.0.1:${port}/api/map`)).json();
    const row1 = map1.sessions.find((s: any) => s.id === sid);
    expect(row1.summary).toBeNull();
    expect(row1.stale).toBe(true);

    // 요약을 현재 seq에 박으면 fresh, 워크스페이스 배치도 같은 판에 실린다.
    await fetch(`http://127.0.0.1:${port}/api/sessions/${sid}/annotations`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mapSummary: { title: '테스트 작업', note: '한 줄', status: 'run', atSeq: row1.lastSeq, updatedAt: Date.now() } }),
    });
    await fetch(`http://127.0.0.1:${port}/api/workspaces/${wsId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ map: { stream: '검증 줄기', column: 3, order: 0 } }),
    });
    const map2 = await (await fetch(`http://127.0.0.1:${port}/api/map`)).json();
    const row2 = map2.sessions.find((s: any) => s.id === sid);
    expect(row2.summary.title).toBe('테스트 작업');
    expect(row2.stale).toBe(false);
    const ws2 = map2.workspaces.find((w: any) => w.id === wsId);
    expect(ws2.map.stream).toBe('검증 줄기');

    // 세션에 출력이 흐르면 그 요약은 즉시 낡은 것으로 표시되어야 한다.
    const sendRes = await fetch(`http://127.0.0.1:${port}/api/sessions/${sid}/send`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: 'hello-map\n' }),
    });
    expect(sendRes.status).toBe(200);
    const t0 = Date.now();
    let row3 = row2;
    while (Date.now() - t0 < 5000) {
      const map3 = await (await fetch(`http://127.0.0.1:${port}/api/map`)).json();
      row3 = map3.sessions.find((s: any) => s.id === sid);
      if (row3.stale) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(row3.stale).toBe(true);
    await fetch(`http://127.0.0.1:${port}/api/sessions/${sid}`, { method: 'DELETE' }).catch(() => {});
  });

  it('the summarizer prompt round-trips and resets; the api key is write-only', async () => {
    const port = (server!.httpServer.address() as AddressInfo).port;
    // 기본 지시문이 유효본이다
    const d1 = await (await fetch(`http://127.0.0.1:${port}/api/map/prompt`)).json();
    expect(d1.isDefault).toBe(true);
    expect(d1.prompt).toContain('작업 지도');
    // 편집 → 유효본 교체, 리셋(빈 문자열) → 기본 복귀
    const d2 = await (await fetch(`http://127.0.0.1:${port}/api/map/prompt`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '커스텀 지시문: JSON만 내라' }),
    })).json();
    expect(d2.isDefault).toBe(false);
    const d3 = await (await fetch(`http://127.0.0.1:${port}/api/map/prompt`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '' }),
    })).json();
    expect(d3.isDefault).toBe(true);

    // 키: 쓰면 set=true가 되지만 키 자체는 어떤 GET으로도 안 나온다
    const k1 = await (await fetch(`http://127.0.0.1:${port}/api/map/api-key`)).json();
    expect(k1.set).toBe(false);
    await fetch(`http://127.0.0.1:${port}/api/map/api-key`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'sk-test-write-only' }),
    });
    const k2 = await (await fetch(`http://127.0.0.1:${port}/api/map/api-key`)).json();
    expect(k2).toEqual({ set: true });
    const cfg = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json();
    expect(JSON.stringify(cfg)).not.toContain('sk-test-write-only');
    // 비우면 해제
    await fetch(`http://127.0.0.1:${port}/api/map/api-key`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: '' }),
    });
    expect((await (await fetch(`http://127.0.0.1:${port}/api/map/api-key`)).json()).set).toBe(false);
  });
});

describe('agentIsActive — liveness rule for the tab dot', () => {
  const NOW = 1_800_000_000_000;

  it('a fresh activity stamp keeps the flag alive', () => {
    expect(agentIsActive({ claudeActive: true, agentActiveAt: NOW - 1000 }, NOW)).toBe(true);
  });

  it('an aged-out stamp reads as idle even though the flag is still true', () => {
    // Stop curl 유실(서버 재시작 창 등)의 잔재 — 5일짜리 점멸 사고의 재발 방지.
    expect(agentIsActive({ claudeActive: true, agentActiveAt: NOW - AGENT_ACTIVE_TTL_MS - 1 }, NOW)).toBe(false);
  });

  it('a flag with no stamp at all (pre-liveness fossil) reads as idle', () => {
    expect(agentIsActive({ claudeActive: true }, NOW)).toBe(false);
  });

  it('no flag means idle regardless of stamp', () => {
    expect(agentIsActive({ agentActiveAt: NOW }, NOW)).toBe(false);
    expect(agentIsActive({ codexActive: true, agentActiveAt: NOW - 1 }, NOW)).toBe(true);
  });


});
