import { describe, expect, it } from 'vitest';
import { mkdtempSync, openSync, readFileSync, rmSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAsyncLog } from './async-log.js';

// 로그가 파일이면 node는 동기로 쓴다 — 디스크가 밀리면 event loop가 선다(압박 벤치: writeSync에 32초).
describe('async log', () => {
  it('returns at once while the disk is stuck, keeps order, and caps what it holds', () => {
    const pending: Array<() => void> = [];
    const written: string[] = [];
    // 디스크가 멈춘 것처럼: 콜백을 붙잡아 둔다
    const log = createAsyncLog(99, { max: 100, write: (_fd, b, cb) => { pending.push(() => { written.push(b.toString()); cb(null, b.length); }); } });
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) log.write(Buffer.from(`l${i}\n`));
    expect(performance.now() - t0).toBeLessThan(50);
    expect(log.dropped).toBeGreaterThan(0); // 100바이트 상한
    // 디스크가 풀린다
    while (pending.length) pending.shift()!();
    log.write(Buffer.from('after\n'));
    while (pending.length) pending.shift()!();
    const text = written.join('');
    const lines = text.split('\n').filter(Boolean);
    const nums = lines.filter((l) => /^l\d+$/.test(l)).map((l) => Number(l.slice(1)));
    expect(nums).toEqual([...nums].sort((a, b) => a - b)); // 순서
    expect(nums[0]).toBe(0);
    expect(text).toMatch(/\[log\] dropped \d+ bytes/);
    expect(lines[lines.length - 1]).toBe('after');
  });

  it('writes a real file in order and requeues a short write', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ttym-alog-'));
    const path = join(dir, 'x.log');
    const fd = openSync(path, 'a');
    let short = true;
    const { write: fsWrite } = await import('node:fs');
    const log = createAsyncLog(fd, { write: (f, b, cb) => {
      const n = short ? Math.min(3, b.length) : b.length; short = false; // 첫 쓰기는 일부만
      fsWrite(f, b, 0, n, null, (err, w) => cb(err, w));
    } });
    for (let i = 0; i < 200; i++) log.write(Buffer.from(`line ${i}\n`));
    for (let i = 0; i < 50 && log.queued > 0; i++) await new Promise((r) => setTimeout(r, 10));
    closeSync(fd);
    const want = Array.from({ length: 200 }, (_, i) => `line ${i}\n`).join('');
    expect(readFileSync(path, 'utf8')).toBe(want);
    rmSync(dir, { recursive: true });
  });
});

describe('async log at exit (2026-11-09 review)', () => {
  it('flushSync does not rewrite the chunk already handed to the kernel, and keeps what is queued behind it', () => {
    const written: string[] = [];
    let complete: (() => void) | null = null;
    const log = createAsyncLog(99, {
      write: (_fd, b, cb) => { complete = () => { written.push(b.toString()); cb(null, b.length); }; },
      writeSync: (_fd, b) => { written.push(b.toString()); },
    });
    log.write(Buffer.from('A\n')); // in flight
    log.write(Buffer.from('B\n')); // queued
    complete!();                    // the kernel finishes A after all
    // (A가 끝나고 바로 B가 in flight로 넘어갔다 — 다시 A·B를 쓰면 안 된다)
    const before = written.join('');
    log.write(Buffer.from('C\n'));
    log.flushSync();
    expect(before).toBe('A\n');
    expect(written.join('')).toContain('disk stalled at exit'); // B가 아직 쓰는 중이라 순서가 바뀔 수 있음을 남긴다
    expect(written.join('').split('A\n').length - 1).toBe(1);
    expect(written.join('')).toContain('C\n');
  });

  it('on an error exit the in-flight chunk is written again rather than lost', () => {
    const written: string[] = [];
    const log = createAsyncLog(99, { write: () => {}, writeSync: (_fd, b) => { written.push(b.toString()); } });
    log.write(Buffer.from('fatal: x\n')); // 스레드풀에 넘어간 채 프로세스가 끝난다
    log.flushSync(true);
    expect(written.join('')).toBe('fatal: x\n');
  });

  it('drain waits for the in-flight write and the queue', async () => {
    const written: string[] = [];
    const log = createAsyncLog(99, { write: (_fd, b, cb) => { setTimeout(() => { written.push(b.toString()); cb(null, b.length); }, 30); } });
    log.write(Buffer.from('A\n'));
    log.write(Buffer.from('B\n'));
    await log.drain(2000);
    expect(written.join('')).toBe('A\nB\n');
    expect(log.queued).toBe(0);
  });

  it('reports dropped bytes at exit even if nothing is logged after the drop', () => {
    const written: string[] = [];
    const log = createAsyncLog(99, { max: 100, write: () => {}, writeSync: (_fd, b) => { written.push(b.toString()); } });
    log.write(Buffer.from('x'.repeat(60))); // in flight forever
    log.write(Buffer.from('y'.repeat(60))); // over the cap → dropped
    log.flushSync();
    expect(written.join('')).toMatch(/\[log\] dropped 60 bytes/);
  });
});
