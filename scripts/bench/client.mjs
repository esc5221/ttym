#!/usr/bin/env node
/**
 * ttym 벤치 클라이언트. 세션·뷰어 부하를 만들고, 사용자가 느끼는 지연을 단계별로 잰다.
 *
 * 1순위 지표: 키 → 화면 왕복(probe 세션은 `stty raw -echo; cat` — 보낸 글자가 그대로 돌아온다)
 * 그 외: /api/sessions 응답, 서버 RSS·swap·CPU, cgroup 메모리·swap·PSI, 재시작 때 끊긴 시간
 *
 * 환경 변수(run.sh가 채운다)
 *   BENCH_PORT          서버 포트
 *   BENCH_FRAMES        synth.mjs 출력 폴더
 *   BENCH_STAGES        JSON [{ "name", "secs", "stress"?: "5G", "restart"?: true }]
 *   BENCH_IDLE / BENCH_BUSY / BENCH_STREAM / BENCH_CLIENTS   세션·뷰어 수
 *   BENCH_SERVER_PID    서버 pid를 출력하는 셸 명령
 *   BENCH_STRESS_START  메모리 압박 시작 명령(%BYTES%를 바꿔 넣음) / BENCH_STRESS_STOP
 *   BENCH_RESTART       서버 재시작 명령
 *   BENCH_CGROUP        cgroup 폴더(memory.current 등을 읽음)
 *   BENCH_OUT           결과 JSON 경로
 */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const req = createRequire(resolve(here, '../../packages/server/package.json'));
const WebSocket = req('ws');

const env = process.env;
const PORT = Number(env.BENCH_PORT || 7961);
const BASE = `http://127.0.0.1:${PORT}`;
const FRAMES = env.BENCH_FRAMES;
const STAGES = JSON.parse(env.BENCH_STAGES || '[{"name":"calm","secs":30}]');
const N_IDLE = Number(env.BENCH_IDLE || 120);
const N_BUSY = Number(env.BENCH_BUSY || 60);
const N_STREAM = Number(env.BENCH_STREAM || 10);
const N_CLIENTS = Number(env.BENCH_CLIENTS || 40);
const CMD = { DATA: 0x00, ATTACH: 0x08, ACK: 0x0b };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

// ── frames (protocol: [u16 sessionId][u8 cmd][payload]; server→client DATA has a u32 seq) ──
function enc(sid, cmd, payload = new Uint8Array(0)) {
  const f = new Uint8Array(3 + payload.length);
  f[0] = sid & 0xff; f[1] = (sid >> 8) & 0xff; f[2] = cmd; f.set(payload, 3);
  return f;
}
function dec(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (b.length < 3) return null;
  const sid = b[0] | (b[1] << 8); const cmd = b[2];
  if ((cmd === 0x00 || cmd === 0x0a) && b.length >= 7) return { sid, cmd, seq: (b[3] | (b[4] << 8) | (b[5] << 16) | (b[6] << 24)) >>> 0, payload: b.subarray(7) };
  return { sid, cmd, payload: b.subarray(3) };
}
const json = (o) => new TextEncoder().encode(JSON.stringify(o));

async function http(path, opts = {}, timeoutMs = 30_000) {
  const t0 = now();
  try {
    const res = await fetch(BASE + path, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.text();
    return { ok: res.ok, ms: now() - t0, body };
  } catch {
    return { ok: false, ms: now() - t0, body: '' };
  }
}

async function createSession(cmd) {
  const r = await http('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd, cols: 100, rows: 30 }) });
  if (!r.ok) throw new Error(`create failed: ${r.body.slice(0, 200)}`);
  return JSON.parse(r.body).id;
}
async function markAgent(id) {
  await http(`/api/internal/sessions/${id}/agent`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ claudeSessionId: `bench-${id}`, claudeActive: false }) });
}
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

// ── viewers ──
function viewer(sessionIds, onData) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const lastSeq = new Map();
  let ackTimer = null;
  const ready = new Promise((resolveOpen, reject) => {
    ws.once('open', () => {
      for (const sid of sessionIds) ws.send(enc(sid, CMD.ATTACH, json({ mode: 'readwrite' })));
      ackTimer = setInterval(() => {
        for (const [sid, seq] of lastSeq) if (ws.readyState === 1) ws.send(enc(sid, CMD.ACK, json({ seq })));
      }, 200);
      resolveOpen();
    });
    ws.once('error', reject);
  });
  ready.catch(() => {}); // 재시작 중 거절된 연결은 다음 단계에서 다시 붙는다 — 처리 안 된 reject로 죽지 않게
  ws.on('message', (raw) => {
    const f = dec(raw);
    if (!f) return;
    if (f.cmd === 0x00 && f.seq !== undefined) lastSeq.set(f.sid, f.seq);
    if (onData && f.cmd === 0x00) onData(f);
  });
  ws.on('error', () => {});
  return { ws, ready, close() { clearInterval(ackTimer); try { ws.terminate(); } catch {} } };
}

// ── metrics ──
function stats(arr) {
  if (!arr.length) return { n: 0 };
  const s = [...arr].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, p50: +q(0.5).toFixed(1), p90: +q(0.9).toFixed(1), p99: +q(0.99).toFixed(1), max: +s[s.length - 1].toFixed(1) };
}
function serverPid() { try { return Number(execSync(env.BENCH_SERVER_PID, { encoding: 'utf8' }).trim()) || 0; } catch { return 0; } }
function procMem(pid) {
  try {
    const st = readFileSync(`/proc/${pid}/status`, 'utf8');
    const kb = (k) => Number((new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(st) || [])[1] || 0);
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    return { rssMB: kb('VmRSS') / 1024, swapMB: kb('VmSwap') / 1024, ticks: Number(stat[11]) + Number(stat[12]) };
  } catch { return null; }
}
function cgroup() {
  const dir = env.BENCH_CGROUP;
  if (!dir) return null;
  try {
    const r = (f) => readFileSync(`${dir}/${f}`, 'utf8');
    const psi = /some avg10=([\d.]+)/.exec(r('memory.pressure'));
    return { memMB: Number(r('memory.current')) / 2 ** 20, swapMB: Number(r('memory.swap.current')) / 2 ** 20, psi10: psi ? Number(psi[1]) : 0 };
  } catch { return null; }
}

// ── run ──
const result = { started: new Date().toISOString(), port: PORT, label: env.BENCH_LABEL || '', commit: env.BENCH_COMMIT || '', setup: {}, stages: [] };

const t0 = now();
const probeId = await createSession(['/bin/sh', '-c', 'stty raw -echo; exec cat']);
const busy = Array.from({ length: N_BUSY }, (_, i) => ['/bin/sh', '-c', `i=${i}; while :; do cat ${FRAMES}/redraw-$(printf %02d $((i % 40))).ansi; i=$((i+1)); sleep 0.25; done`]);
const streams = Array.from({ length: N_STREAM }, (_, i) => ['/bin/sh', '-c', `i=${i}; while :; do cat ${FRAMES}/stream-$(printf %02d $((i % 10))).ansi; i=$((i+1)); sleep 20; done`]);
const idle = Array.from({ length: N_IDLE }, () => ['/bin/sh', '-c', 'printf "idle\\r\\n$ "; exec sleep 100000000']);
const ids = [];
await pool([...busy, ...streams, ...idle], 8, async (cmd) => { ids.push(await createSession(cmd)); });
await pool(ids, 8, markAgent);
result.setup = { sessions: ids.length + 1, busy: N_BUSY, stream: N_STREAM, idle: N_IDLE, clients: N_CLIENTS, secs: +((now() - t0) / 1000).toFixed(1) };
console.error(`[bench] ${ids.length + 1} sessions in ${result.setup.secs}s`);

let viewers = [];
function connectViewers() {
  viewers = Array.from({ length: N_CLIENTS }, (_, k) => viewer(Array.from({ length: 5 }, (_, j) => ids[(k * 5 + j) % ids.length])));
}

// probe: one viewer on the cat session
let probe = null;
let pending = null; // { token, t, resolve }
let probeBuf = '';
function connectProbe() {
  probeBuf = '';
  probe = viewer([probeId], (f) => {
    if (f.sid !== probeId) return;
    probeBuf += Buffer.from(f.payload).toString('latin1');
    if (probeBuf.length > 4096) probeBuf = probeBuf.slice(-1024);
    if (pending && probeBuf.includes(pending.token)) { const p = pending; pending = null; p.resolve(now() - p.t); }
  });
}
let tokenN = 0;
function rtt(timeoutMs = 30_000) {
  return new Promise((resolveRtt) => {
    const token = `k${(++tokenN).toString(36)}z`;
    const timer = setTimeout(() => { if (pending?.token === token) { pending = null; resolveRtt(timeoutMs); } }, timeoutMs);
    pending = { token, t: now(), resolve: (ms) => { clearTimeout(timer); resolveRtt(ms); } };
    try { probe.ws.send(enc(probeId, CMD.DATA, new TextEncoder().encode(token))); } catch {}
  });
}

connectViewers();
connectProbe();
await Promise.allSettled([probe.ready, ...viewers.map((v) => v.ready)]);
await sleep(3000);

for (const st of STAGES) {
  console.error(`[bench] stage ${st.name} ${st.secs}s${st.stress ? ` stress=${st.stress}` : ''}${st.restart ? ' restart' : ''}`);
  const out = { name: st.name, secs: st.secs, stress: st.stress || null };
  if (st.stress && env.BENCH_STRESS_START) execSync(env.BENCH_STRESS_START.replace('%BYTES%', st.stress), { stdio: 'ignore' });
  if (st.restart && env.BENCH_RESTART) {
    for (const v of viewers) v.close();
    probe.close();
    const tR = now();
    execSync(env.BENCH_RESTART, { stdio: 'ignore' });
    let up = false;
    while (now() - tR < 180_000) { const r = await http('/api/sessions', {}, 5000); if (r.ok) { up = true; break; } await sleep(100); }
    out.restartApiMs = up ? Math.round(now() - tR) : null;
    connectProbe();
    await probe.ready.catch(() => {});
    const first = await rtt(60_000);
    out.restartFirstEchoMs = Math.round(now() - tR);
    out.restartFirstRtt = Math.round(first);
    connectViewers();
  }
  const rtts = []; const apis = []; const mem = []; const cg = [];
  let timeouts = 0;
  const pid0 = serverPid();
  const m0 = pid0 ? procMem(pid0) : null; const c0 = Date.now();
  const end = now() + st.secs * 1000;
  const rttLoop = (async () => { while (now() < end) { const ms = await rtt(); if (ms >= 30_000) timeouts++; rtts.push(ms); await sleep(250); } })();
  const apiLoop = (async () => { while (now() < end) { const r = await http('/api/sessions'); apis.push(r.ok ? r.ms : 30_000); await sleep(1000); } })();
  const memLoop = (async () => { while (now() < end) { const pid = serverPid(); const m = pid && procMem(pid); if (m) mem.push(m); const c = cgroup(); if (c) cg.push(c); await sleep(2000); } })();
  await Promise.all([rttLoop, apiLoop, memLoop]);
  const pid1 = serverPid(); const m1 = pid1 ? procMem(pid1) : null;
  out.rtt = { ...stats(rtts), timeouts };
  out.api = stats(apis);
  out.server = {
    rssMaxMB: +Math.max(0, ...mem.map((m) => m.rssMB)).toFixed(0),
    swapMaxMB: +Math.max(0, ...mem.map((m) => m.swapMB)).toFixed(0),
    cpuPct: m0 && m1 && pid0 === pid1 ? +(((m1.ticks - m0.ticks) / 100) / ((Date.now() - c0) / 1000) * 100).toFixed(1) : null,
  };
  if (cg.length) out.cgroup = { memMaxMB: +Math.max(...cg.map((c) => c.memMB)).toFixed(0), swapMaxMB: +Math.max(...cg.map((c) => c.swapMB)).toFixed(0), psi10Max: Math.max(...cg.map((c) => c.psi10)) };
  if (st.stress && env.BENCH_STRESS_STOP) execSync(env.BENCH_STRESS_STOP, { stdio: 'ignore' });
  result.stages.push(out);
  console.error(`[bench]   rtt p50=${out.rtt.p50} p99=${out.rtt.p99} max=${out.rtt.max} timeouts=${timeouts} · api p99=${out.api.p99} · rss ${out.server.rssMaxMB}MB swap ${out.server.swapMaxMB}MB`);
}

for (const v of viewers) v.close();
probe.close();
result.finished = new Date().toISOString();
if (env.BENCH_OUT) writeFileSync(env.BENCH_OUT, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result));
process.exit(0);
