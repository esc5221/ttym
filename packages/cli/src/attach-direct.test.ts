import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { FrameReader, frame, holderSocketOf, openViewer, resolveDirectTarget } from './attach-direct.js';
import { SessionManager } from '../../server/src/session-manager.js';

// ttym attach --direct: 서버를 거치지 않고 holder에 viewer로 붙는다. 서버(node)가 멈춰도 된다.
const DIR = resolve('/tmp', `ttym-direct-${process.pid}`);
const NEW_HOLDER = resolve(__dirname, '../../../holder/target/release/ttym-holder');
const OLD_HOLDER = resolve(__dirname, '../../../../../dist/ttym-holder'); // 메인 작업 폴더의 prod 바이너리(있을 때만)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const managers: SessionManager[] = [];
const procs: ChildProcess[] = [];

afterEach(async () => {
  delete process.env.TTYM_HOLDER_BIN;
  for (const p of procs.splice(0)) { try { p.kill('SIGCONT'); p.kill('SIGKILL'); } catch {} }
  while (managers.length) managers.pop()!.destroyAll();
  await sleep(200);
  try { rmSync(DIR, { recursive: true }); } catch {}
});

async function sessionWith(holder: string, script: string) {
  const run = resolve(DIR, 'run');
  mkdirSync(run, { recursive: true });
  process.env.TTYM_HOLDER_BIN = holder;
  const m = new SessionManager(run);
  managers.push(m);
  await m.boot();
  const s = await m.create(['/bin/sh', '-c', script], 80, 24);
  return { run, m, s };
}

function collect(sock: import('node:net').Socket, reader: FrameReader, early: Array<{ cmd: number; payload: Buffer }>) {
  let text = '';
  const take = (f: { cmd: number; payload: Buffer }) => { if (f.cmd === 0x03) text += f.payload.subarray(4).toString('utf8'); };
  early.forEach(take);
  sock.on('data', (c: Buffer) => reader.feed(c).forEach(take));
  return () => text;
}

describe('attach --direct', () => {
  it('resolves %id and ws:member from disk, and finds the holder socket from the manifest', async () => {
    const { run, s } = await sessionWith(NEW_HOLDER, 'sleep 30');
    writeFileSync(resolve(run, 'workspaces.json'), JSON.stringify({ version: 1, workspaces: [{ id: 'w1', name: 'work', members: [{ sessionId: s.id, name: 'sh' }] }] }));
    expect(resolveDirectTarget(`%${s.id}`, run)).toBe(s.id);
    expect(resolveDirectTarget('work:sh', run)).toBe(s.id);
    expect(resolveDirectTarget('work:nope', run)).toBeNull();
    expect(holderSocketOf(s.id, run)).toMatch(/\.sock$/);
  }, 30_000);

  it('reads and types through the holder while the server is stopped', async () => {
    // 서버를 별도 프로세스로 띄우고 SIGSTOP — 이 프로세스(테스트)는 holder에만 붙는다.
    const run = resolve(DIR, 'run');
    mkdirSync(run, { recursive: true });
    const serverJs = resolve(__dirname, '../../../dist/ttym-server.js');
    if (!existsSync(serverJs)) return;
    const port = 17800 + (process.pid % 100);
    const server = spawn(process.execPath, [serverJs], {
      env: { HOME: process.env.HOME!, PATH: process.env.PATH!, TTYM_HOME: DIR, TTYM_RUNTIME_DIR: run, PORT: String(port), TTYM_HOLDER_BIN: NEW_HOLDER },
      stdio: 'ignore',
    });
    procs.push(server);
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/api/health`); break; } catch { await sleep(100); } }
    const created = await (await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: ['/bin/sh', '-c', 'stty -echo; while read x; do echo "GOT:$x"; done'], cols: 80, rows: 24 }),
    })).json() as { id: number };
    await sleep(500);
    server.kill('SIGSTOP');
    const socketPath = holderSocketOf(created.id, run)!;
    const { sock, reader, early } = await openViewer(socketPath, 0);
    const text = collect(sock, reader, early);
    sock.write(frame(0x04, Buffer.from('ping-1\n')));
    for (let i = 0; i < 50 && !text().includes('GOT:ping-1'); i++) await sleep(100);
    expect(text()).toContain('GOT:ping-1');
    sock.destroy();
    server.kill('SIGCONT');
    // 서버도 멈춘 동안의 출력을 이어 받는다(journal 커서)
    let screen = '';
    for (let i = 0; i < 50; i++) {
      screen = await (await fetch(`http://127.0.0.1:${port}/api/sessions/${created.id}/screen`)).text();
      if (screen.includes('GOT:ping-1')) break;
      await sleep(100);
    }
    expect(screen).toContain('GOT:ping-1');
    await fetch(`http://127.0.0.1:${port}/api/sessions/${created.id}`, { method: 'DELETE' }).catch(() => {});
  }, 30_000);

  it.skipIf(!existsSync(OLD_HOLDER))('refuses an older holder with a reason, and leaves the server attached', async () => {
    const { m, s } = await sessionWith(OLD_HOLDER, 'sleep 30');
    const socketPath = holderSocketOf(s.id, m.runtimeDir)!;
    await expect(openViewer(socketPath, 0)).rejects.toThrow(/older holder/);
    await sleep(300);
    expect(m.get(s.id)?.isDead).toBe(false);
  }, 30_000);
});
