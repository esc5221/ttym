#!/usr/bin/env node
// 새로고침 E2E — headless chromium이 실제 웹 UI를 띄우고 검증한다.
//
// 지키려는 성질: "새로고침 직후의 터미널 화면은 새 출력 없이도 그려진다."
// 한 번 깨진 적이 있다 — seq 워터마크를 sessionStorage에 보존하는 최적화가
// 리로드된 백지 xterm에 델타만 흘려보내 화면이 영영 비었다. 세션은 marker를
// 찍고 exec cat으로 침묵하므로, 리로드 후 marker가 보인다면 그것은 반드시
// 스냅샷 경로가 그린 것이다.
//
// 사전 조건: ./scripts/build.sh 완료 (dist/ttym-server.js + packages/web/dist)
// 실행: node scripts/e2e-refresh.mjs

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import WebSocket from 'ws';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 17690 + Math.floor(Math.random() * 500);
const HOME = mkdtempSync(join(tmpdir(), 'ttym-e2e-'));
const MARKER = 'E2E-MARKER-' + Math.random().toString(36).slice(2, 8).toUpperCase();

const CMD = { DATA: 0, CREATE: 2, DESTROY: 3, HELLO: 6, SNAPSHOT: 10 };
const enc = (sid, cmd, obj) => {
  const payload = obj ? Buffer.from(JSON.stringify(obj)) : Buffer.alloc(0);
  const f = Buffer.alloc(3 + payload.length);
  f.writeUInt16LE(sid, 0); f[2] = cmd; payload.copy(f, 3);
  return f;
};

let serverProc = null;
let browser = null;
let failures = 0;

function startServer() {
  serverProc = spawn('node', [join(ROOT, 'dist', 'ttym-server.js')], {
    env: { ...process.env, TTYM_HOME: HOME, PORT: String(PORT) },
    stdio: 'ignore',
  });
}

async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/version`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server did not come up');
}

function stopServer() {
  return new Promise((resolve) => {
    if (!serverProc || serverProc.exitCode !== null) return resolve();
    serverProc.once('exit', resolve);
    serverProc.kill('SIGTERM');
    setTimeout(() => { try { serverProc.kill('SIGKILL'); } catch {} }, 8000).unref();
  });
}

function wsOnce() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.on('open', () => { ws.send(enc(0, CMD.HELLO, { clientId: 'e2e' })); resolve(ws); });
    ws.on('error', reject);
  });
}

async function createMarkerSession() {
  const ws = await wsOnce();
  const sid = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CREATE timed out')), 10000);
    ws.on('message', (buf) => {
      if (buf[2] === CMD.CREATE) { clearTimeout(timer); resolve(buf.readUInt16LE(0)); }
    });
    ws.send(enc(0, CMD.CREATE, {
      cmd: ['/bin/sh', '-lc', `printf '${MARKER}\\n'; stty -echo; exec cat`],
      cols: 80, rows: 24,
    }));
  });
  ws.close();
  return sid;
}

async function destroySession(sid) {
  try {
    const ws = await wsOnce();
    ws.send(enc(sid, CMD.DESTROY));
    await new Promise((r) => setTimeout(r, 400));
    ws.close();
  } catch {}
}

async function expectMarker(page, label, timeoutMs) {
  try {
    await page.waitForFunction(
      (marker) => document.body.innerText.includes(marker),
      MARKER,
      { timeout: timeoutMs },
    );
    console.log(`  PASS  ${label}`);
  } catch {
    failures++;
    console.log(`  FAIL  ${label} — ${timeoutMs}ms 안에 marker가 화면에 없음`);
  }
}

try {
  startServer();
  await waitForServer();
  const sid = await createMarkerSession();

  const wsRes = await fetch(`http://127.0.0.1:${PORT}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'e2e-ws', project: 'default', name: 'e2e',
      layout: { type: 'pane', sessionId: sid }, members: [],
    }),
  });
  if (wsRes.status !== 201) throw new Error(`workspace create failed: ${wsRes.status}`);

  // WebGL을 꺼서 DOM 렌더러로 강제 — 화면 텍스트를 innerText로 검증 가능.
  browser = await chromium.launch({ headless: true, args: ['--disable-webgl', '--disable-gpu'] });
  const page = await browser.newPage();

  await page.goto(`http://127.0.0.1:${PORT}/#w/e2e-ws`);
  await expectMarker(page, '최초 로드가 화면을 그린다', 10000);

  // 본편: 세션은 침묵 중 — 리로드 후 보이는 건 전부 스냅샷의 공로다.
  await page.reload();
  await expectMarker(page, '새로고침 직후 새 출력 없이 화면이 그려진다', 5000);

  const stored = await page.evaluate(() => sessionStorage.getItem('ttym-last-seqs'));
  if (stored === null) console.log('  PASS  seq 워터마크를 sessionStorage에 남기지 않는다');
  else { failures++; console.log(`  FAIL  ttym-last-seqs가 저장돼 있음: ${stored}`); }

  // 서버 재시작: seq는 1부터 다시 시작하고 세션은 holder에서 부활한다.
  // 이 직후의 새로고침이 빈 화면이던 것이 실측된 결함이었다.
  await stopServer();
  startServer();
  await waitForServer();
  await page.reload();
  await expectMarker(page, '서버 재시작 후 새로고침도 화면이 그려진다', 8000);

  await destroySession(sid);
} catch (error) {
  failures++;
  console.log(`  FAIL  ${error.message}`);
} finally {
  try { await browser?.close(); } catch {}
  await stopServer();
  rmSync(HOME, { recursive: true, force: true });
}

console.log(failures === 0 ? 'e2e-refresh: ALL PASS' : `e2e-refresh: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
