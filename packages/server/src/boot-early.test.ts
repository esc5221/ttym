import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import WebSocket from 'ws';
import type { AddressInfo } from 'node:net';
import { SessionManager } from './session-manager.js';
import { createServer, type TtymServer } from './server.js';
import { CMD, decode, encode, toBuffer } from './protocol.js';

// 서버 재시작 때 복원을 기다리지 않고 먼저 listen한다(2026-11-08: 압박 중 재시작에서 세션 196개 복원이 2분,
// 그동안 포트가 닫혀 있었다). 아직 안 돌아온 세션은 목록에 recovering으로 보이고, 그 세션으로 온 요청은 기다린다.
const DIR = resolve('/tmp', `ttym-boot-early-${process.pid}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const managers: SessionManager[] = [];
let server: TtymServer | null = null;

afterEach(async () => {
  delete process.env.TTYM_TEST_RECOVER_DELAY_MS;
  delete process.env.TTYM_RUNTIME_DIR;
  delete process.env.TTYM_HOME;
  if (server) { await server.close().catch(() => {}); server = null; }
  while (managers.length) managers.pop()!.destroyAll();
  await sleep(200);
  try { rmSync(DIR, { recursive: true }); } catch {}
});

/** 세션 n개를 띄우고 서버가 죽은 것처럼 떠난다 — holder는 살아 있다. */
async function leaveHolders(run: string, n: number): Promise<number[]> {
  mkdirSync(run, { recursive: true });
  const m1 = new SessionManager(run);
  await m1.boot();
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = await m1.create(['/bin/sh', '-c', `printf 'hello-${i}\\r\\n'; sleep 60`], 80, 24);
    ids.push(s.id);
  }
  await sleep(300);
  for (const id of ids) await m1.persistSession(id);
  await m1.shutdown();
  for (const id of ids) (m1.get(id) as unknown as { sock: { destroy(): void } | null } | undefined)?.sock?.destroy();
  managers.push(m1); // destroyAll로 holder 정리
  await sleep(200);
  return ids;
}

describe('boot before recovery finishes', () => {
  it('lists pending sessions as recovering, keeps ids apart, and releases waiters when each one is back', async () => {
    const run = resolve(DIR, 'run');
    const ids = await leaveHolders(run, 3);
    process.env.TTYM_TEST_RECOVER_DELAY_MS = '400';
    const m2 = new SessionManager(run);
    managers.unshift(m2);
    await m2.bootPrepare();
    // 복원 전: 셋 다 자리표시
    const before = m2.list();
    expect(before.map((s) => s.id).sort()).toEqual([...ids].sort());
    expect(before.every((s) => s.recovering === true)).toBe(true);
    expect(ids.every((id) => m2.isPending(id))).toBe(true);
    // 복원 중에 새 세션: 아직 안 돌아온 id와 겹치지 않는다
    const done = m2.bootFinish();
    const fresh = await m2.create(['/bin/sh', '-c', 'sleep 30'], 80, 24);
    expect(ids).not.toContain(fresh.id);
    expect(fresh.id).toBeGreaterThan(Math.max(...ids));
    // 기다리던 요청은 그 세션이 돌아오면 풀린다
    const t0 = Date.now();
    await m2.whenRecovered(ids[0]!);
    expect(m2.get(ids[0]!)).toBeTruthy();
    expect(m2.isPending(ids[0]!)).toBe(false);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(200);
    await done;
    expect(m2.list().some((s) => s.recovering)).toBe(false);
    expect(m2.get(ids[2]!)!.screenText()).toContain('hello-2');
  }, 30_000);

  it('runs the recovered hook before releasing waiters, and holds sessions until the hook is set', async () => {
    const run = resolve(DIR, 'run');
    const [id] = await leaveHolders(run, 1);
    const m2 = new SessionManager(run);
    managers.unshift(m2);
    await m2.bootPrepare();
    m2.expectRecoveredHook();
    const order: string[] = [];
    void m2.bootFinish();
    void m2.whenRecovered(id!).then(() => order.push('released'));
    await sleep(800);
    // 훅이 없으니 세션은 붙었어도 아직 놓이지 않는다
    expect(m2.isPending(id!)).toBe(true);
    expect(order).toEqual([]);
    m2.setRecoveredHook(async (rid) => { order.push(`hook ${rid}`); await sleep(50); });
    await m2.whenRecovered(id!);
    await sleep(10);
    expect(order).toEqual([`hook ${id}`, 'released']);
  }, 30_000);

  it('the server listens at once; an attach to a pending session waits and then succeeds', async () => {
    const run = resolve(DIR, 'run');
    const ids = await leaveHolders(run, 2);
    process.env.TTYM_RUNTIME_DIR = run;
    process.env.TTYM_HOME = DIR;
    process.env.TTYM_TEST_RECOVER_DELAY_MS = '1500';
    const t0 = Date.now();
    server = await createServer(0);
    const startMs = Date.now() - t0;
    expect(startMs).toBeLessThan(1500); // 복원(세션당 1.5초)을 기다리지 않았다
    const port = (server.httpServer.address() as AddressInfo).port;
    const listed = await (await fetch(`http://127.0.0.1:${port}/api/sessions`)).json() as Array<{ id: number; recovering?: boolean }>;
    expect(listed.filter((s) => ids.includes(s.id)).every((s) => s.recovering)).toBe(true);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((r) => ws.once('open', r));
    const got = new Promise<{ ok: boolean }>((resolveAttach) => {
      ws.on('message', (raw) => {
        const f = decode(toBuffer(raw));
        if (f && f.cmd === CMD.ATTACH && f.sessionId === ids[1]) resolveAttach(JSON.parse(Buffer.from(f.payload).toString()));
      });
    });
    ws.send(encode(ids[1]!, CMD.ATTACH, Buffer.from(JSON.stringify({ mode: 'readwrite' }))));
    const reply = await got;
    expect(reply.ok).toBe(true);
    ws.close();
    // 복원이 끝난 뒤 gc가 돌아도 세션 파일은 그대로
    await server.manager.recovered;
    await sleep(200);
    const files = readdirSync(run);
    for (const id of ids) expect(files).toContain(`session-${id}.json`);
  }, 30_000);

  it('a pending pane does not hold up frames for other panes on the same connection', async () => {
    const run = resolve(DIR, 'run');
    const ids = await leaveHolders(run, 1);
    process.env.TTYM_RUNTIME_DIR = run;
    process.env.TTYM_HOME = DIR;
    process.env.TTYM_TEST_RECOVER_DELAY_MS = '2000';
    server = await createServer(0);
    const port = (server.httpServer.address() as AddressInfo).port;
    // 복원 중에 새로 만든 세션
    const fresh = await (await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: ['/bin/sh', '-c', 'sleep 30'], cols: 80, rows: 24 }),
    })).json() as { id: number };
    expect(server.manager.isPending(ids[0]!)).toBe(true);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((r) => ws.once('open', r));
    const order: number[] = [];
    const both = new Promise<void>((done) => {
      ws.on('message', (raw) => {
        const f = decode(toBuffer(raw));
        if (f && f.cmd === CMD.ATTACH) { order.push(f.sessionId); if (order.length === 2) done(); }
      });
    });
    ws.send(encode(ids[0]!, CMD.ATTACH, Buffer.from(JSON.stringify({ mode: 'readwrite' }))));   // 아직 복원 중
    ws.send(encode(fresh.id, CMD.ATTACH, Buffer.from(JSON.stringify({ mode: 'readwrite' })))); // 이미 있음
    await both;
    expect(order).toEqual([fresh.id, ids[0]]);
    ws.close();
  }, 30_000);
});
