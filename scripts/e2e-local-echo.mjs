#!/usr/bin/env node
// 로컬 에코(예측 에코) E2E — 느린 링크를 실제로 만들어 놓고 폰 화면에서 친다.
//
//   chromium (iPhone 13 에뮬레이션, 실제 웹 UI, local echo 켬)
//        │ /ws 만 지연 — 편도 L/2 + 지터. HTTP(/api·정적 파일)는 그대로 통과
//   지연 프록시 ── 클라→서버 SNAPSHOT 요청을 센다 = 예측이 어긋난 횟수
//        │
//   격리 ttym 서버 (임시 TTYM_HOME, 랜덤 포트, 이 트리의 dist)
//        └ 실제 PTY: zsh -f · 사용자 zsh · bash · claude · read -s
//
// 예측을 켜는 것은 설정이 아니라 컨트롤러가 잰 왕복이다(SRTT > 30ms). 프록시가 만든
// 지연을 컨트롤러가 스스로 재서 켜지는 경로를 그대로 탄다.
//
// 사용:
//   node scripts/e2e-local-echo.mjs                       # 250ms, 전 시나리오
//   node scripts/e2e-local-echo.mjs --latency 150 --only zsh-rc,claude
//   node scripts/e2e-local-echo.mjs --echo off            # 대조군: 예측 없이
//   node scripts/e2e-local-echo.mjs --echo tolerant       # 개선 모드 (기본 on = classic)
//   node scripts/e2e-local-echo.mjs --record <dir>        # 서버 쪽 바이트를 fixture로 저장
//   node scripts/e2e-local-echo.mjs --json out.json
//
// 선행: dist/ttym-server.js · dist/ttym (scripts/build.sh), packages/web/dist.
// holder는 dist/ttym-holder, 없으면 TTYM_HOLDER_BIN.

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { chromium, devices } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? dflt : process.argv[i + 1]; };
const LATENCY = Number(arg('latency', '250'));
const JITTER = Number(arg('jitter', '0.2'));
const ECHO = arg('echo', 'on');   // off · on(classic) · tolerant
const ONLY = arg('only', '')?.split(',').filter(Boolean);
const RECORD = arg('record', null);
const JSON_OUT = arg('json', null);
const KEY_GAP = Number(arg('gap', '90'));   // 사람이 폰으로 치는 간격 근처
const SAMPLE_MS = 16;

const PORT = 17690 + Math.floor(Math.random() * 400);
const PROXY_PORT = PORT + 500;
const HOME = mkdtempSync(join(tmpdir(), 'ttym-echo-e2e-'));
const HOLDER = existsSync(join(ROOT, 'dist', 'ttym-holder')) ? join(ROOT, 'dist', 'ttym-holder') : process.env.TTYM_HOLDER_BIN;
const CLI = join(ROOT, 'dist', 'ttym');
const LOCAL_ECHO_KEY = 'ttym-demo-local-echo';
const CMD = { DATA: 0x00, SNAPSHOT: 0x0a };

// ── 시나리오 ──
// keys: 문자열은 한 글자씩, { key } 는 특수키. prep: 치기 전에 셸에 넣는 것. ready: 화면에 이게 보이면 시작.
const SCENARIOS = [
  { name: 'zsh-plain', cmd: ['/bin/zsh', '-f'], prep: "PS1='$ '; clear\n", keys: 'echo hello world' },
  // fc -p: 빈 히스토리로 — 실제 히스토리가 있으면 자동완성이 친 문장을 통째로 미리 그려 지표가 무의미해진다.
  { name: 'zsh-rc', cmd: ['/bin/zsh'], prep: 'fc -p; clear\n', keys: 'echo hello world' },
  { name: 'bash', cmd: ['/bin/bash', '--norc'], prep: "PS1='$ '; clear\n", keys: 'echo hello world' },
  { name: 'korean', cmd: ['/bin/zsh', '-f'], prep: "PS1='$ '; clear\n", keys: 'echo 안녕하세요 반가워요' },
  { name: 'emoji', cmd: ['/bin/zsh', '-f'], prep: "PS1='$ '; clear\n", keys: 'echo hi 🙂 ok' },
  { name: 'backspace', cmd: ['/bin/zsh', '-f'], prep: "PS1='$ '; clear\n", keys: ['echo helo', { key: 'Backspace' }, { key: 'Backspace' }, 'lo wrold', { key: 'Backspace' }, { key: 'Backspace' }, { key: 'Backspace' }, 'ld'] },
  { name: 'backspace-ko', cmd: ['/bin/zsh', '-f'], prep: "PS1='$ '; clear\n", keys: ['echo 안녕하', { key: 'Backspace' }, '세요'] },
  // 워밍업(왕복 측정)은 평범한 셸에서 끝낸 뒤 read -s 로 들어간다 — 에코가 꺼진 채로는 표본이 안 쌓여 예측이 아예 안 켜진다.
  { name: 'password', cmd: ['/bin/zsh', '-f'], prep: "PS1='$ '; clear\n", afterWarm: "read -s 'pw?Password: '\n", ready: 'Password:', keys: 'hunter2secret', secret: true },
  { name: 'claude', cmd: ['/bin/zsh', '-f'], prep: 'clear; CLAUDE_CODE_SANDBOXED=1 claude --dangerously-skip-permissions\n', ready: 'bypass permissions', readyTimeout: 30000, keys: 'hello there general kenobi' },
];

// ── 격리 서버 ──
let serverProc = null;
function startServer() {
  const env = { ...process.env, TTYM_HOME: HOME, PORT: String(PORT) };
  // 이 셸이 ttym pane 안이면 그 신원이 새면 안 된다 — 격리 서버가 prod 세션인 척하게 된다.
  for (const k of Object.keys(env)) if (/^TTYM_(SESSION_ID|PORT|BUS_URL)$/.test(k)) delete env[k];
  if (HOLDER) env.TTYM_HOLDER_BIN = HOLDER;
  serverProc = spawn('node', [join(ROOT, 'dist', 'ttym-server.js')], { env, stdio: 'ignore' });
}
async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { try { if (await fn()) return; } catch {} await sleep(150); }
  throw new Error(`timeout: ${what}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (path, init) => fetch(`http://127.0.0.1:${PORT}${path}`, init).then((r) => r.json());
const cli = (...args) => JSON.parse(execFileSync(CLI, [...args, '--json'], { env: { ...process.env, TTYM_HOME: HOME, PORT: String(PORT) } }).toString());

// ── 지연 프록시 ──
// 방향마다 큐 하나. 도착 순서를 지키려고 내보낼 시각은 직전 것보다 앞설 수 없다(지터가 순서를 뒤집지 않게).
const stats = new Map();   // sid → { snapshots }
let recording = null;      // sid → { t0, inputs, frames }
function delayer() {
  let last = 0;
  return (fn) => {
    const oneWay = (LATENCY / 2) * (1 + (Math.random() * 2 - 1) * JITTER);
    const at = Math.max(last, performance.now() + oneWay);
    last = at;
    setTimeout(fn, Math.max(0, at - performance.now()));
  };
}
function startProxy() {
  const server = http.createServer((req, res) => {
    const up = http.request({ host: '127.0.0.1', port: PORT, path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res);
    });
    up.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (client) => {
      const upstream = new WebSocket(`ws://127.0.0.1:${PORT}${req.url}`, { headers: { origin: req.headers.origin ?? '', host: req.headers.host ?? '' } });
      const toServer = delayer(); const toClient = delayer();
      const queued = [];
      upstream.on('open', () => { for (const m of queued.splice(0)) upstream.send(m); });
      client.on('message', (data, isBinary) => {
        const buf = Buffer.from(data);
        if (isBinary && buf.length >= 3) {
          const sid = buf.readUInt16LE(0); const cmd = buf[2];
          if (cmd === CMD.SNAPSHOT) { const s = stats.get(sid); if (s) s.snapshots++; }
        }
        toServer(() => {
          if (isBinary && buf.length >= 3 && buf[2] === CMD.DATA) {
            const r = recording?.get(buf.readUInt16LE(0));
            if (r) r.inputs.push({ t: +(performance.now() - r.t0).toFixed(1), b: [...buf.subarray(3)] });
          }
          if (upstream.readyState === WebSocket.OPEN) upstream.send(buf, { binary: isBinary }); else queued.push(buf);
        });
      });
      upstream.on('message', (data, isBinary) => {
        const buf = Buffer.from(data);
        if (isBinary && buf.length >= 7 && buf[2] === CMD.DATA) {
          const r = recording?.get(buf.readUInt16LE(0));
          if (r) r.frames.push({ t: +(performance.now() - r.t0).toFixed(1), b: [...buf.subarray(7)] });
        }
        toClient(() => { if (client.readyState === WebSocket.OPEN) client.send(buf, { binary: isBinary }); });
      });
      const closeBoth = () => { try { client.close(); } catch {} try { upstream.close(); } catch {} };
      client.on('close', closeBoth); upstream.on('close', closeBoth); upstream.on('error', closeBoth);
    });
  });
  return new Promise((r) => server.listen(PROXY_PORT, '127.0.0.1', () => r(server)));
}

// ── 한 시나리오 ──
async function screenText(sid) {
  const s = await api(`/api/sessions/${sid}/screen`);
  return String(s.screen ?? '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
}

async function run(browser, sc) {
  const ws = cli('workspace', 'create', `echo-${sc.name}`);
  const member = cli('workspace', 'add', `echo-${sc.name}`, '--name', 'p', '--cwd', HOME, '--cmd', ...sc.cmd).member;
  const sid = member.sessionId;
  await sleep(600);
  await fetch(`http://127.0.0.1:${PORT}/api/sessions/${sid}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: sc.prep }) });
  if (sc.ready && !sc.afterWarm) await waitFor(async () => (await screenText(sid)).replace(/\s/g, '').includes(sc.ready.replace(/\s/g, '')), sc.readyTimeout ?? 8000, `${sc.name} ready`);
  await sleep(800);

  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  await ctx.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch {} }, [LOCAL_ECHO_KEY, ECHO === 'tolerant' ? '2' : ECHO === 'on' ? '1' : '0']);
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${PROXY_PORT}/#w/${ws.id}/p/${sid}`);
  await page.waitForSelector('.xterm-rows', { timeout: 15000 });
  await sleep(1500);
  await page.tap('.xterm-screen');

  // 왕복을 재게 한다 — 컨트롤러는 인쇄 가능한 입력 뒤 첫 출력으로 SRTT를 쌓아야 예측을 켠다.
  // 한 글자 치고 지우기를 몇 번. 제어키는 표본을 만들지 않는다.
  for (let i = 0; i < 6; i++) { await page.keyboard.type('x'); await sleep(LATENCY + 120); await page.keyboard.press('Backspace'); await sleep(LATENCY + 120); }
  await sleep(LATENCY * 2 + 300);

  if (sc.afterWarm) {
    await fetch(`http://127.0.0.1:${PORT}/api/sessions/${sid}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: sc.afterWarm }) });
    await waitFor(async () => (await screenText(sid)).replace(/\s/g, '').includes(sc.ready.replace(/\s/g, '')), 8000, `${sc.name} ready`);
    await sleep(LATENCY * 2 + 300);
  }
  stats.set(sid, { snapshots: 0 });
  if (RECORD) {
    // 녹화 시작 시점의 화면 — 재생이 같은 프롬프트에서 출발하도록.
    const initial = String((await api(`/api/sessions/${sid}/screen`)).screen ?? '');
    recording = new Map([[sid, { t0: performance.now(), inputs: [], frames: [], initial }]]);
  }

  // 페이지 시계로 화면을 샘플링한다 — 키 입력 시각도 같은 시계로 찍는다.
  await page.evaluate((ms) => {
    const w = window; w.__s = []; w.__keys = [];
    const tick = () => {
      const rows = [...document.querySelectorAll('.xterm-rows > div')].map((r) => r.textContent ?? '');
      w.__s.push({ t: performance.now(), rows });
      if (!w.__stop) setTimeout(tick, ms);
    };
    tick();
  }, SAMPLE_MS);

  const typed = [];   // 화면에 있어야 할 입력 줄의 변화
  let text = '';
  const items = Array.isArray(sc.keys) ? sc.keys : [sc.keys];
  for (const item of items) {
    const chars = typeof item === 'string' ? Array.from(item) : [item];
    for (const ch of chars) {
      const t = await page.evaluate(() => performance.now());
      if (typeof ch === 'string') { await page.keyboard.type(ch); text += ch; }
      else { await page.keyboard.press(ch.key); if (ch.key === 'Backspace') text = Array.from(text).slice(0, -1).join(''); }
      typed.push({ t, text, bs: typeof ch !== 'string' });
      await sleep(KEY_GAP);
    }
  }
  await sleep(LATENCY * 3 + 1500);   // 스냅샷 복구까지 끝나게
  const samples = await page.evaluate(() => { window.__stop = true; return window.__s; });
  const snapshots = stats.get(sid).snapshots;
  const rec = recording?.get(sid); recording = null;
  const geometry = (await api('/api/sessions')).find?.((x) => x.id === sid) ?? null;

  // 최종 화면: 브라우저의 입력 줄 vs 서버 화면
  const final = samples[samples.length - 1].rows;
  const server = (await screenText(sid)).split('\n');
  const expect = sc.secret ? null : text;
  const squash = (rows) => rows.join('').replace(/\s/g, '');
  const finalOk = sc.secret
    ? !flat(final).includes(text.slice(0, 3))
    : squash(final).includes(expect.replace(/\s/g, '')) && squash(server).includes(expect.replace(/\s/g, ''));

  const m = measure(samples, typed, sc);
  if (!finalOk && process.env.DUMP) {
    const nonEmpty = (rows) => rows.map((r) => r.replace(/\s+$/, '')).filter(Boolean).slice(-6).join('\n    ');
    console.log(`  [${sc.name}] expect ${JSON.stringify(expect)}\n  browser:\n    ${nonEmpty(final)}\n  server:\n    ${nonEmpty(server)}`);
  }
  await ctx.close();
  cli('workspace', 'delete', `echo-${sc.name}`);
  await fetch(`http://127.0.0.1:${PORT}/api/sessions/${sid}`, { method: 'DELETE' }).catch(() => {});
  return { name: sc.name, snapshots, finalOk, errors: errors.length, ...m, fixture: rec, geometry: geometry && { cols: geometry.cols, rows: geometry.rows } };
}

/**
 * 화면 샘플에서 지표를 뽑는다.
 *   firstGlyph  키를 누른 뒤 그 키까지의 입력이 화면에 보이기까지(ms) — 중앙값·최대
 *   broken      이미 보였던 입력이 화면에서 사라지거나(되돌림) 같은 입력이 두 번 보인 시간(ms)
 *   exposed     비밀번호: 친 글자가 두 자 이상 이어서 보인 시간(ms)
 */
function measure(samples, typed, sc) {
  const lat = [];
  let k = 0;
  for (const key of typed) {
    if (key.bs) { k++; continue; }
    const want = key.text;
    const hit = samples.find((s) => s.t >= key.t && flat(s.rows).includes(want));
    if (hit) lat.push(hit.t - key.t);
    k++;
  }
  let broken = 0, exposed = 0; const reasons = new Set();
  const baseline = flat(samples[0].rows);
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i]; const dt = s.t - samples[i - 1].t;
    // 이 시점까지 친 것
    const upto = [...typed].reverse().find((x) => x.t <= s.t);
    if (!upto) continue;
    const joined = flat(s.rows);
    // 비밀번호: 친 글자 세 개 이상이 이어서 보이면 노출. 처음 화면에 이미 있던 조각(예: 명령 "read")은 뺀다.
    if (sc.secret) { if (upto.text.length >= 3 && hasRun(joined, upto.text, 3, baseline)) exposed += dt; continue; }
    // 되돌림: 250ms 이전에 친 입력은 이미 확정됐어야 한다 — 그 앞부분이 안 보이면 깨진 화면
    const settled = [...typed].reverse().find((x) => x.t <= s.t - (LATENCY + 200));
    let why = null;
    // 확정 시점 이후의 어떤 입력 상태든 화면에 있으면 정상이다 — 뒤이은 백스페이스가 이미 반영됐을 수 있다.
    const allowed = settled ? typed.filter((x) => x.t >= settled.t && x.t <= s.t).map((x) => x.text) : [];
    if (settled && settled.text.length >= 3 && !allowed.some((x) => joined.includes(x))) why = `missing ${JSON.stringify(settled.text)}`;
    // 이중 표시: 친 입력(4자 이상)이 화면에 두 번
    else if (upto.text.length >= 4 && count(joined, upto.text.slice(-4)) >= 2) why = `twice ${JSON.stringify(upto.text.slice(-4))}`;
    if (why) { broken += dt; if (process.env.DUMP && !reasons.has(why)) { reasons.add(why); console.log(`  [${sc.name}] broken @${Math.round(s.t - typed[0].t)}ms ${why} :: ${JSON.stringify(joined.replace(/\s+/g, ' ').trim().slice(-70))}`); } }
  }
  lat.sort((a, b) => a - b);
  return {
    firstGlyphMed: lat.length ? Math.round(lat[Math.floor(lat.length / 2)]) : null,
    firstGlyphMax: lat.length ? Math.round(lat[lat.length - 1]) : null,
    brokenMs: Math.round(broken),
    exposedMs: Math.round(exposed),
  };
}
/** 화면 행을 이어 붙인다 — 폰 폭(44칸 안팎)에서는 입력 줄이 다음 행으로 넘어간다. */
const flat = (rows) => rows.join('');
const count = (s, sub) => { let n = 0, i = 0; while ((i = s.indexOf(sub, i)) !== -1) { n++; i += sub.length; } return n; };
const hasRun = (s, secret, n, baseline = '') => { const cs = Array.from(secret); for (let i = 0; i + n <= cs.length; i++) { const run = cs.slice(i, i + n).join(''); if (s.includes(run) && !baseline.includes(run)) return true; } return false; };

// ── main ──
async function main() {
  if (!HOLDER) throw new Error('no holder: build dist/ttym-holder or set TTYM_HOLDER_BIN');
  startServer();
  await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/api/version`)).ok, 15000, 'server');
  const proxy = await startProxy();
  const browser = await chromium.launch({ headless: true, args: ['--disable-webgl', '--disable-gpu'] });
  const results = [];
  try {
    for (const sc of SCENARIOS) {
      if (ONLY.length && !ONLY.includes(sc.name)) continue;
      try { results.push(await run(browser, sc)); }
      catch (e) { results.push({ name: sc.name, error: String(e.message ?? e) }); }
      const r = results[results.length - 1];
      console.log(`${r.name.padEnd(13)} ${r.error ? 'ERROR ' + r.error : `glyph med ${String(r.firstGlyphMed).padStart(4)}ms max ${String(r.firstGlyphMax).padStart(4)}ms · broken ${String(r.brokenMs).padStart(5)}ms · snapshots ${r.snapshots} · final ${r.finalOk ? 'ok' : 'WRONG'}${r.exposedMs ? ` · EXPOSED ${r.exposedMs}ms` : ''}${r.errors ? ` · pageerrors ${r.errors}` : ''}`}`);
      if (RECORD && r.fixture) {
        mkdirSync(RECORD, { recursive: true });
        writeFileSync(join(RECORD, `${r.name}.json`), JSON.stringify({ scenario: r.name, latency: LATENCY, cols: r.geometry?.cols, rows: r.geometry?.rows, initial: r.fixture.initial, inputs: r.fixture.inputs, frames: r.fixture.frames }));
      }
      delete r.fixture; delete r.geometry;
    }
  } finally {
    await browser.close();
    proxy.close();
    serverProc?.kill('SIGTERM');
    await sleep(500);
    rmSync(HOME, { recursive: true, force: true });
  }
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ latency: LATENCY, echo: ECHO, results }, null, 1));
}
main().catch((e) => { console.error(e); serverProc?.kill('SIGTERM'); process.exit(1); });
