#!/usr/bin/env node
/**
 * 서버가 세션마다 드는 @xterm/headless 터미널의 실제 비용을 잰다.
 * 입력: 런타임 폴더의 snapshot-*.json (실제 체크포인트 화면). 내용은 출력하지 않는다.
 *
 *   node --expose-gc scripts/measure/headless-mem.mjs ~/.ttym/run [N=100] [scrollback=3000]
 *
 * 재는 것: 세션당 JS 힙·ArrayBuffer·RSS, 버퍼 줄 수, 직렬화(전체/1000줄)·복원 시간,
 * 전체 GC 시간, 화면 읽기 sweep 시간, 직렬화 문자열·zlib 크기.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { performance, PerformanceObserver } from 'node:perf_hooks';
import { deflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const req = createRequire(resolve(here, '../../packages/server/package.json'));
const { Terminal } = req('@xterm/headless');
const { SerializeAddon } = req('@xterm/addon-serialize');

const [dir, nArg = '100', sbArg = '3000'] = process.argv.slice(2);
const N = parseInt(nArg, 10);
const SCROLLBACK = parseInt(sbArg, 10);
if (!global.gc) { console.error('run with --expose-gc'); process.exit(1); }

const snaps = readdirSync(dir).filter((f) => /^snapshot-\d+\.json$/.test(f))
  .map((f) => { try { return JSON.parse(readFileSync(resolve(dir, f), 'utf8')); } catch { return null; } })
  .filter((s) => s && typeof s.screen === 'string' && s.screen.length > 0)
  .sort((a, b) => b.screen.length - a.screen.length);
// 큰 것만 고르지 않게: 크기순으로 고르게 N개를 뽑는다
const pick = [];
for (let i = 0; i < N && snaps.length; i++) pick.push(snaps[Math.floor(i * snaps.length / Math.min(N, snaps.length))]);
const uniq = [...new Set(pick)];

const mem = () => { global.gc(); global.gc(); const m = process.memoryUsage(); return { heap: m.heapUsed, ab: m.arrayBuffers, ext: m.external, rss: m.rss }; };
const write = (t, s) => new Promise((r) => t.write(s, r));
const mb = (b) => (b / 1e6).toFixed(1);
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

const base = mem();
const terms = [];
const tWrite = [];
for (const s of uniq) {
  const t = new Terminal({ cols: s.cols, rows: s.rows, scrollback: SCROLLBACK, allowProposedApi: true });
  const ser = new SerializeAddon();
  t.loadAddon(ser);
  const t0 = performance.now();
  await write(t, s.screen);
  tWrite.push(performance.now() - t0);
  terms.push({ t, ser, cols: s.cols, rows: s.rows });
}
const loaded = mem();

const lines = terms.map(({ t }) => t.buffer.active.length);
const cells = terms.reduce((a, { t, cols }) => a + t.buffer.active.length * cols, 0);

// GC: 모든 터미널이 살아 있는 상태에서 전체 GC 한 번
const gcTimes = [];
const obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) gcTimes.push(e.duration); });
obs.observe({ entryTypes: ['gc'] });
const g0 = performance.now(); global.gc(); const gcFull = performance.now() - g0;
await new Promise((r) => setTimeout(r, 50));
obs.disconnect();

// sweep: 3초 sweep처럼 모든 세션의 보이는 화면을 문자열로 읽는다
const s0 = performance.now();
for (const { t } of terms) {
  const b = t.buffer.active; const rows = [];
  for (let i = 0; i < t.rows; i++) rows.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? '');
}
const sweepMs = performance.now() - s0;

// 직렬화·복원
const serFull = [], ser1000 = [], restore = [], strBytes = [], zBytes = [], latin1 = [];
for (const { ser, cols, rows } of terms) {
  let a = performance.now(); const full = ser.serialize(); serFull.push(performance.now() - a);
  a = performance.now(); ser.serialize({ scrollback: 1000 }); ser1000.push(performance.now() - a);
  const isLatin1 = !/[^\u0000-ÿ]/.test(full);
  latin1.push(isLatin1);
  strBytes.push(full.length * (isLatin1 ? 1 : 2));
  zBytes.push(deflateSync(Buffer.from(full), { level: 6 }).length);
  const t2 = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
  a = performance.now(); await write(t2, full); restore.push(performance.now() - a);
  t2.dispose();
}

const n = terms.length;
const sum = (a) => a.reduce((x, y) => x + y, 0);
const out = {
  sessions: n, scrollback: SCROLLBACK,
  linesAvg: Math.round(sum(lines) / n), linesMax: Math.max(...lines), linesAt3000Plus: lines.filter((l) => l >= SCROLLBACK).length,
  perSession: {
    heapMB: +mb((loaded.heap - base.heap) / n), arrayBufMB: +mb((loaded.ab - base.ab) / n), rssMB: +mb((loaded.rss - base.rss) / n),
    bytesPerCell: +(((loaded.heap - base.heap) + (loaded.ab - base.ab)) / cells).toFixed(1),
    serializedKB: +(sum(strBytes) / n / 1e3).toFixed(0), zlibKB: +(sum(zBytes) / n / 1e3).toFixed(0),
  },
  total: { heapMB: +mb(loaded.heap - base.heap), arrayBufMB: +mb(loaded.ab - base.ab), rssMB: +mb(loaded.rss - base.rss),
           serializedMB: +mb(sum(strBytes)), zlibMB: +mb(sum(zBytes)), latin1Share: +(latin1.filter(Boolean).length / n).toFixed(2) },
  ms: {
    gcFull: +gcFull.toFixed(1), gcEntriesMax: +(Math.max(0, ...gcTimes)).toFixed(1),
    sweepAll: +sweepMs.toFixed(1),
    serializeFull: { p50: +pct(serFull, 0.5).toFixed(1), p95: +pct(serFull, 0.95).toFixed(1), max: +Math.max(...serFull).toFixed(1), sum: +sum(serFull).toFixed(0) },
    serialize1000: { p50: +pct(ser1000, 0.5).toFixed(1), p95: +pct(ser1000, 0.95).toFixed(1) },
    restore: { p50: +pct(restore, 0.5).toFixed(1), p95: +pct(restore, 0.95).toFixed(1), max: +Math.max(...restore).toFixed(1), sum: +sum(restore).toFixed(0) },
    initialWrite: { p50: +pct(tWrite, 0.5).toFixed(1), p95: +pct(tWrite, 0.95).toFixed(1) },
  },
};
console.log(JSON.stringify(out, null, 1));
