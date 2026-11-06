import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import headless from '@xterm/headless';
import { SessionManager } from './session-manager.js';
import { screenTail, tailCursor } from './screen-tail.js';
import type { Session } from './session.js';

const { Terminal } = headless as unknown as { Terminal: typeof import('@xterm/headless').Terminal };

// 쉬는 세션의 터미널을 내렸다가(cold) 다시 세운(warm) 뒤의 화면이, 한 번도 내리지 않고 같은 바이트를
// 받은 터미널과 같은지. 기준 바이트는 holder journal(파일)에서 읽는다 — 세션이 실제로 받은 스트림이다.
const DIR = resolve('/tmp', `ttym-cold-test-${process.pid}`);
const managers: SessionManager[] = [];
afterEach(async () => {
  while (managers.length) managers.pop()!.destroyAll();
  await new Promise((r) => setTimeout(r, 200));
  try { rmSync(DIR, { recursive: true }); } catch {}
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 색·넓은 글자·커서 이동·래핑·스크롤·동기 블록·OSC 133이 섞인 출력 */
function richOutput(tag: string, lines: number): string {
  let s = '';
  for (let i = 0; i < lines; i++) {
    s += `\x1b[3${i % 8}m${tag}-${i}\x1b[0m 한국어 넓은글자 ${'x'.repeat(i % 50)} \x1b[1;4mbold\x1b[0m\r\n`;
    if (i % 17 === 0) s += '\x1b]133;A\x07$ cmd\x1b]133;C\x07';
    if (i % 23 === 0) s += '\x1b[?2026h\x1b[2A\x1b[Kredraw ' + i + '\x1b[2B\x1b[?2026l\r\n';
    if (i % 31 === 0) s += '\x1b]133;D;0\x07';
    if (i % 41 === 0) s += 'y'.repeat(200) + '\r\n'; // 래핑되는 긴 줄
  }
  return s;
}

function journalBytes(run: string, id: number): Buffer {
  const f = readdirSync(run).find((n) => n.startsWith(`journal-${id}-`))!;
  return readFileSync(resolve(run, f));
}

async function reference(bytes: Buffer, cols: number, rows: number) {
  const t = new Terminal({ cols, rows, scrollback: 3000, allowProposedApi: true });
  await new Promise<void>((r) => t.write(bytes, r));
  return t;
}

function allText(t: InstanceType<typeof Terminal>): string[] {
  const b = t.buffer.active; const out: string[] = [];
  for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '');
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

async function sessionAllText(session: Session, cols: number, rows: number): Promise<string[]> {
  // 세션의 전체 스크롤백을 그대로 다른 터미널에 다시 그려 읽는다(직렬화본이 곧 세션이 아는 화면).
  return allText(await reference(Buffer.from(session.snapshot()), cols, rows));
}

describe('cold sessions', () => {
  it('a cold session answers the screen from its cache, and a warmed one matches a never-cold terminal', async () => {
    mkdirSync(DIR, { recursive: true });
    const run = resolve(DIR, 'run');
    const manager = new SessionManager(run);
    managers.push(manager);
    await manager.boot();
    const file1 = resolve(DIR, 'a.ansi');
    const file2 = resolve(DIR, 'b.ansi');
    writeFileSync(file1, richOutput('A', 400));
    writeFileSync(file2, richOutput('B', 120));
    const cols = 100, rows = 30;
    // 첫 출력 → (쉼) → 신호 파일이 생기면 두 번째 출력
    const go = resolve(DIR, 'go');
    const script = `stty -onlcr; cat ${file1}; while [ ! -f ${go} ]; do sleep 0.05; done; cat ${file2}; printf 'END\\r\\n'; sleep 30`;
    const session = await manager.create(['/bin/sh', '-c', script], cols, rows);
    await sleep(800);

    const before = { text: session.screenText(), tail: session.screenTail(rows), cur: session.tailCursor(rows), snap: session.snapshot() };
    expect(session.goCold()).toBe(true);
    expect(session.isCold).toBe(true);
    // 내린 상태에서도 같은 답
    expect(session.screenText()).toBe(before.text);
    expect(session.screenTail(rows)).toEqual(before.tail);
    expect(session.screenTail(5)).toEqual(screenTailSlice(before.tail, 5));
    expect(session.tailCursor(rows)).toEqual(before.cur);
    expect(session.snapshot()).toBe(before.snap);
    expect(session.isCold).toBe(true);

    // 출력이 오면(내린 채로 받아 모아 두었다가) 다시 세운다
    writeFileSync(go, '1');
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !session.screenText().includes('END')) await sleep(100);
    expect(session.isCold).toBe(false);
    expect(session.screenText()).toContain('END');

    const ref = await reference(journalBytes(run, session.id), cols, rows);
    expect(session.screenTail(rows)).toEqual(screenTail(ref, rows));
    expect(session.tailCursor(rows)).toEqual(tailCursor(ref, rows));
    expect(await sessionAllText(session, cols, rows)).toEqual(allText(ref));
  }, 30_000);

  it('a marker taken while cold points at the row right after the warm, before new output', async () => {
    mkdirSync(DIR, { recursive: true });
    const manager = new SessionManager(resolve(DIR, 'run'));
    managers.push(manager);
    await manager.boot();
    const go = resolve(DIR, 'go2');
    const session = await manager.create(['/bin/sh', '-c',
      `stty -onlcr; printf 'first\r\n'; while [ ! -f ${go} ]; do sleep 0.05; done; printf 'second\r\nthird\r\n'; sleep 30`], 80, 24);
    await sleep(600);
    expect(session.goCold()).toBe(true);
    const marker = session.markCursor()!;
    await session.ensureWarm();
    writeFileSync(go, '1');
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !session.screenText().includes('third')) await sleep(50);
    const tr = session.transcriptSince(marker);
    expect(tr).toContain('second');
    expect(tr).toContain('third');
    expect(tr).not.toContain('first');
  }, 30_000);

  it('does not go cold with a viewer, in the alternate screen, or while output is recent', async () => {
    mkdirSync(DIR, { recursive: true });
    const manager = new SessionManager(resolve(DIR, 'run'));
    managers.push(manager);
    await manager.boot();
    const s1 = await manager.create(['/bin/sh', '-c', "printf 'hi\\r\\n'; sleep 30"], 80, 24);
    const s2 = await manager.create(['/bin/sh', '-c', "printf '\\033[?1049halt\\r\\n'; sleep 30"], 80, 24);
    await sleep(500);
    s1.addViewer('v', () => {});
    expect(s1.goCold()).toBe(false);
    expect(s2.goCold()).toBe(false);
    expect(s1.canGoCold(Date.now(), 60_000)).toBe(false);
    s1.removeViewer('v');
    expect(s1.canGoCold(Date.now() + 120_000, 60_000)).toBe(true);
    expect(manager.coolIdle(Date.now() + 120_000, 60_000)).toBe(1); // s1만 (s2는 alternate)
    expect(s1.isCold).toBe(true);
    expect(s2.isCold).toBe(false);
  }, 30_000);

  it('resize while cold is applied when it warms', async () => {
    mkdirSync(DIR, { recursive: true });
    const run = resolve(DIR, 'run');
    const manager = new SessionManager(run);
    managers.push(manager);
    await manager.boot();
    const session = await manager.create(['/bin/sh', '-c', "stty -onlcr; i=0; while [ $i -lt 50 ]; do i=$((i+1)); printf 'row %s %s\\r\\n' $i $(printf '%080d' 0); done; sleep 30"], 120, 20);
    await sleep(800);
    expect(session.goCold()).toBe(true);
    session.resize(60, 20);
    await session.ensureWarm();
    expect(session.isCold).toBe(false);
    const ref = await reference(journalBytes(run, session.id), 120, 20);
    ref.resize(60, 20);
    expect(session.screenTail(20)).toEqual(screenTail(ref, 20));
  }, 30_000);
});

function screenTailSlice<T>(rows: T[], n: number): T[] { return rows.slice(Math.max(0, rows.length - n)); }
