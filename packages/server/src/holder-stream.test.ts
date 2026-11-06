import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { SessionManager } from './session-manager.js';

// 서버가 holder 소켓을 읽지 않을 때(이벤트 루프 정지·SIGSTOP·메모리 압박) pane 안의 프로그램이 멈추지 않고,
// 재개 뒤 서버가 받은 스트림에 빠진 것·겹친 것이 없어야 한다.
// 2026-11-06 측정: 이전 holder는 PTY 읽기 루프 안에서 blocking write를 해서, 서버 정지 5초 동안 pane 출력이 0줄이었다.
const DIR = resolve('/tmp', `ttym-stream-test-${process.pid}`);
const COUNTER = resolve(DIR, 'counter');
const managers: SessionManager[] = [];

afterEach(async () => {
  while (managers.length) managers.pop()!.destroyAll();
  await new Promise((r) => setTimeout(r, 200));
  try { rmSync(DIR, { recursive: true }); } catch {}
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const counter = () => { try { return parseInt(readFileSync(COUNTER, 'utf8'), 10) || 0; } catch { return 0; } };

describe('holder journal streaming', () => {
  it('keeps the pane program running while the server does not read, and loses nothing', async () => {
    mkdirSync(DIR, { recursive: true });
    const manager = new SessionManager(resolve(DIR, 'run'));
    managers.push(manager);
    await manager.boot();
    // 줄마다 번호(20만 줄, 약 1.7MB). 500줄마다 카운터 파일을 갱신해 서버와 무관하게 진행을 잰다.
    const script = `i=0; while [ $i -lt 200000 ]; do i=$((i+1)); echo "L$i"; if [ $((i % 500)) -eq 0 ]; then echo $i > ${COUNTER}; fi; done; echo DONE`;
    const session = await manager.create(['/bin/sh', '-c', script], 80, 24);
    expect(session.holderCaps).toContain('journal');
    // 서버가 내보내는 스트림을 처음부터 끝까지 모은다(링은 항목 상한으로 앞을 버린다).
    const got: Buffer[] = [];
    session.addViewer('stream-test', (data: Buffer) => { got.push(Buffer.from(data)); });

    await sleep(300);
    const sock = (session as unknown as { sock: { pause(): void; resume(): void } }).sock;
    sock.pause();
    const before = counter();
    await sleep(3000);
    const during = counter();
    sock.resume();

    // 프로그램은 서버가 안 읽는 동안에도 계속 썼다
    expect(during - before).toBeGreaterThan(5000);

    const deadline = Date.now() + 30_000;
    let text = '';
    while (Date.now() < deadline) {
      text = Buffer.concat(got).toString('latin1');
      if (text.includes('DONE')) break;
      await sleep(200);
    }
    expect(text).toContain('DONE');
    const nums = [...text.matchAll(/L(\d+)\r?\n/g)].map((m) => parseInt(m[1]!, 10));
    // 일시정지 구간 전부가 검사 범위 안이어야 의미가 있다
    expect(nums[0]!).toBeLessThan(before);
    for (let k = 1; k < nums.length; k++) {
      if (nums[k] !== nums[k - 1]! + 1) throw new Error(`stream broke at ${nums[k - 1]} → ${nums[k]}`);
    }
    expect(nums[nums.length - 1]).toBe(200000);
    expect(session.integrity).toBe('healthy');
  }, 60_000);

  it('removes its journal file when the session ends', async () => {
    mkdirSync(DIR, { recursive: true });
    const run = resolve(DIR, 'run');
    const manager = new SessionManager(run);
    managers.push(manager);
    await manager.boot();
    const session = await manager.create(['/bin/sh', '-c', 'echo hi; sleep 0.3'], 80, 24);
    const { readdirSync } = await import('node:fs');
    const journals = () => readdirSync(run).filter((f) => f.startsWith(`journal-${session.id}-`));
    expect(journals().length).toBe(1);
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline && journals().length > 0) await sleep(500);
    expect(existsSync(run)).toBe(true);
    expect(journals().length).toBe(0);
  }, 60_000);
});
