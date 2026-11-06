import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SessionManager } from './session-manager.js';

// 세션이 생기자마자 출력을 쏟으면(생성 handshake 중 출력), 이전 서버는 덤프와 실시간 출력에 같은 바이트를
// 두 번 적용하고 체크포인트 offset을 어긋나게 저장했다 → 재시작 뒤 같은 출력이 두 번 그려졌다
// (2026-11-06 리허설: 51개 중 2개). 같은 runtime dir에 서버를 다시 붙여 화면이 그대로인지 본다.
const DIR = resolve('/tmp', `ttym-restart-dup-${process.pid}`);
const OLD_HOLDER = '/Users/lullu/study/ttym/dist/ttym-holder'; // prod에 떠 있는 holder와 같은 바이너리(있을 때만)
const managers: SessionManager[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(async () => {
  while (managers.length) managers.pop()!.destroyAll();
  delete process.env.TTYM_HOLDER_BIN;
  await sleep(300);
  try { rmSync(DIR, { recursive: true }); } catch {}
});

function body(): string {
  let s = '';
  for (let i = 0; i < 1500; i++) s += `\x1b[3${i % 8}mline ${i}\x1b[0m ${'#'.repeat(i % 60)}\r\n`;
  return s;
}

async function roundTrip(holderBin: string | null, skewCheckpoint = false) {
  mkdirSync(DIR, { recursive: true });
  const run = resolve(DIR, 'run');
  const file = resolve(DIR, 'burst.ansi');
  writeFileSync(file, body());
  if (holderBin) process.env.TTYM_HOLDER_BIN = holderBin;
  const m1 = new SessionManager(run);
  await m1.boot();
  // 생성 직후 바로 쏟는다: handshake 중 출력
  const s1 = await m1.create(['/bin/sh', '-c', `stty -onlcr; cat ${file}; printf 'TAIL\\r\\n'; sleep 60`], 100, 30);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !s1.screenText().includes('TAIL')) await sleep(50);
  await sleep(300);
  const before = s1.screenText();
  const beforeAll = s1.snapshot();
  await m1.persistSession(s1.id);
  await m1.shutdown(); // holder는 살아 있다(재시작과 같다)
  // 프로세스가 죽은 것처럼 연결을 끊는다 — 열린 채면 holder가 '다른 서버가 잡고 있음'으로 거절한다.
  (s1 as unknown as { sock: { destroy(): void } | null }).sock?.destroy();
  await sleep(200);
  if (skewCheckpoint) {
    // 이전 서버가 남긴 것처럼: 화면은 끝까지 그려졌는데 offset은 한참 앞(생성 handshake 경쟁의 결과)
    const { readFileSync } = await import('node:fs');
    const p = resolve(run, `snapshot-${s1.id}.json`);
    const snap = JSON.parse(readFileSync(p, 'utf8'));
    snap.appliedThroughOffset = 1000;
    delete snap.cursor;
    writeFileSync(p, JSON.stringify(snap));
  }
  delete process.env.TTYM_HOLDER_BIN;

  const m2 = new SessionManager(run);
  managers.push(m2);
  await m2.boot();
  const s2 = m2.get(s1.id)!;
  expect(s2).toBeTruthy();
  await sleep(300);
  expect(s2.screenText()).toBe(before);
  // 같은 줄이 두 번 나오지 않는다
  const all = s2.snapshot();
  expect((all.match(/line 1499/g) ?? []).length).toBe((beforeAll.match(/line 1499/g) ?? []).length);
  expect((all.match(/TAIL/g) ?? []).length).toBe(1);
}

describe('restart after an output burst during the creation handshake', () => {
  it('new holder: the screen comes back unchanged', async () => {
    await roundTrip(null);
  }, 30_000);

  it.skipIf(!existsSync(OLD_HOLDER))('old holder (prod binary): the screen comes back unchanged', async () => {
    await roundTrip(OLD_HOLDER);
  }, 30_000);

  it.skipIf(!existsSync(OLD_HOLDER))('old holder + a checkpoint whose offset lags its screen (what the old server saved)', async () => {
    await roundTrip(OLD_HOLDER, true);
  }, 30_000);
});
