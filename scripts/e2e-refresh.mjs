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
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
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
const createdSessions = [];
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

async function createSessionWith(cmd) {
  const ws = await wsOnce();
  const sid = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CREATE timed out')), 10000);
    ws.on('message', (buf) => {
      if (buf[2] === CMD.CREATE) { clearTimeout(timer); resolve(buf.readUInt16LE(0)); }
    });
    ws.send(enc(0, CMD.CREATE, { cmd: ['/bin/sh', '-lc', cmd], cols: 80, rows: 24 }));
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
  const sid = await createSessionWith(`printf '${MARKER}\\n'; stty -echo; exec cat`);
  createdSessions.push(sid);

  const wsRes = await fetch(`http://127.0.0.1:${PORT}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'e2e-ws', name: 'e2e',
      layout: { type: 'pane', sessionId: sid }, members: [],
    }),
  });
  if (wsRes.status !== 201) throw new Error(`workspace create failed: ${wsRes.status}`);

  const sid2 = await createSessionWith("printf 'E2E-SECOND-WS\\n'; stty -echo; exec cat");
  createdSessions.push(sid2);
  const ws2Res = await fetch(`http://127.0.0.1:${PORT}/api/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'e2e-ws2', name: 'e2e2',
      layout: { type: 'pane', sessionId: sid2 }, members: [],
    }),
  });
  if (ws2Res.status !== 201) throw new Error(`workspace2 create failed: ${ws2Res.status}`);

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

  // P2: 다른 workspace로 넘어가 pane이 detach된 사이의 출력이, 돌아왔을 때
  // 스냅샷 없이(버퍼 보존 + delta) 화면에 있어야 한다. 세션은 cat이라 이
  // 출력의 유일한 출처는 숨겨진 동안의 echo다.
  await page.goto(`http://127.0.0.1:${PORT}/#w/e2e-ws`);
  await expectMarker(page, 'P2 사전: 첫 workspace 재표시', 5000);
  await page.goto(`http://127.0.0.1:${PORT}/#w/e2e-ws2`);
  try {
    await page.waitForFunction(() => document.body.innerText.includes('E2E-SECOND-WS'), null, { timeout: 8000 });
  } catch (e) {
    const body = await page.evaluate(() => document.body.innerText.slice(0, 600));
    console.log('  [debug] ws2 본문:', JSON.stringify(body));
    throw e;
  }
  await fetch(`http://127.0.0.1:${PORT}/api/sessions/${sid}/send`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: 'P2-HIDDEN-OUT\n' }),
  });
  await new Promise((r) => setTimeout(r, 700));
  await page.goto(`http://127.0.0.1:${PORT}/#w/e2e-ws`);
  try {
    await page.waitForFunction(
      (m) => document.body.innerText.includes(m) && document.body.innerText.includes('P2-HIDDEN-OUT'),
      MARKER, { timeout: 5000 },
    );
    console.log('  PASS  숨겨진 동안의 출력이 복귀한 pane에 (버퍼 보존과 함께) 보인다');
  } catch {
    failures++;
    const has = await page.evaluate(() => document.body.innerText.includes('P2-HIDDEN-OUT'));
    console.log(`  FAIL  복귀 pane 상태 — 기존버퍼:${!has ? '?' : 'ok'} hidden출력:${has}`);
  }

  // 파일 드롭: 브라우저는 실경로를 숨기므로 내용이 서버 drops/로 여행하고,
  // 돌려받은 경로가 인용되어 pane에 타이핑된다. 에코 켠 셸이라 타이핑이
  // 곧 화면 증거다 (-echo 세션에선 개행 전 입력이 안 보인다 — 실측).
  {
    const sid3 = await createSessionWith('exec cat');
    createdSessions.push(sid3);
    await fetch(`http://127.0.0.1:${PORT}/api/workspaces`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'e2e-ws3', name: 'e2e3',
        layout: { type: 'pane', sessionId: sid3 }, members: [] }),
    });
    await page.goto(`http://127.0.0.1:${PORT}/#w/e2e-ws3`);
    await page.waitForTimeout(1500);
    const dispatched = await page.evaluate(() => {
      const pane = document.querySelector('[data-pane-sid]');
      if (!pane) return false;
      const file = new File(['DROP-CONTENT'], 'drop me.txt', { type: 'text/plain' });
      const dt = new DataTransfer();
      dt.items.add(file);
      pane.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return true;
    });
    if (!dispatched) { failures++; console.log('  FAIL  드롭 대상 pane을 찾지 못함'); }
    try {
      await page.waitForFunction(() => document.body.innerText.includes('drop me.txt'), null, { timeout: 5000 });
      const stored = readFileSync(join(HOME, 'drops', 'drop me.txt'), 'utf8');
      if (stored === 'DROP-CONTENT') {
        console.log('  PASS  드롭한 파일이 drops/에 원본명으로 저장되고 인용된 경로가 pane에 꽂힌다');
      } else {
        failures++; console.log('  FAIL  drops/ 내용 불일치:', JSON.stringify(stored));
      }
    } catch {
      failures++;
      console.log('  FAIL  드롭 경로가 화면에 나타나지 않음');
    }
  }

  // 터미널 내 문자열 검색(⌘F): SearchAddon + 찾기바 — 매치 카운트가 뜨는
  // 것까지가 계약. 브라우저 찾기는 캔버스라 원래 무용했다.
  {
    await page.goto(`http://127.0.0.1:${PORT}/#w/e2e-ws`);
    await page.waitForTimeout(1200);
    await page.click('[data-pane-sid]');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+KeyF' : 'Control+KeyF');
    try {
      await page.waitForSelector('input[placeholder="find"]', { timeout: 3000 });
      await page.keyboard.type('E2E-MARKER');
      await page.waitForFunction(
        () => /\b1\/[1-9]/.test(document.body.innerText),
        null, { timeout: 4000 },
      );
      console.log('  PASS  ⌘F 검색 — 찾기바가 열리고 매치 카운트가 뜬다');
      await page.keyboard.press('Escape');
    } catch (e) {
      failures++;
      console.log('  FAIL  터미널 검색 —', String(e).slice(0, 80));
    }
  }

  // 작업 지도 모드: settings의 main view 토글이 지도를 그리고, 요약이
  // 없는 신생 서버에선 안내 문구가 뜬다 (빈 주석 ≠ 오류 원칙의 UI 형태).
  {
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.waitForTimeout(800);
    await page.evaluate(() => localStorage.setItem('ttym-main-view', 'map'));
    await page.reload();
    try {
      await page.waitForSelector('.wmap', { timeout: 5000 });
      await page.waitForFunction(
        () => document.body.innerText.includes('no summaries yet') && document.body.innerText.includes('ttym map refresh'),
        null, { timeout: 4000 },
      );
      console.log('  PASS  지도 모드 — main view 토글로 지도가 뜨고 빈 상태 안내가 보인다');

      // 설정 모달: 열림 → map 섹션에 요약기 설정(프롬프트 기본값 포함) → esc 닫힘
      await page.click('button[aria-label="settings"]');
      await page.waitForSelector('[role="dialog"]', { timeout: 3000 });
      await page.click('[role="dialog"] button:has-text("map")');
      // 프롬프트는 마운트 후 비동기로 도착한다 — 값이 채워질 때까지 기다린다.
      await page.waitForFunction(
        () => {
          const dlg = document.querySelector('[role="dialog"]');
          if (!dlg || !dlg.innerText.includes('base url')) return false;
          const ta = dlg.querySelector('textarea');
          if (!ta || !ta.value.includes('JSON')) return false;
          // one-off 정리 줄과 조립 구조 표시까지가 map 섹션의 계약이다
          return dlg.innerText.includes('refresh now') && dlg.innerText.includes('workspace 목록');
        },
        null, { timeout: 4000 },
      );
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), null, { timeout: 2000 });
      console.log('  PASS  설정 모달 — 섹션 내비·요약기 설정·기본 프롬프트·esc 닫기');
    } catch (e) {
      failures++;
      console.log('  FAIL  지도 모드 —', String(e).slice(0, 80));
    }
    await page.evaluate(() => localStorage.setItem('ttym-main-view', 'preview'));
  }

  // P4: 보고 있는 중에 서버가 죽었다 살아나면, 손대지 않아도 화면이
  // 돌아와야 한다 (onDisconnect → 백오프 재접속 → 리로드 → 스냅샷).
  await page.goto(`http://127.0.0.1:${PORT}/#w/e2e-ws`);
  await expectMarker(page, 'P4 사전: 관측 중 화면 정상', 5000);
  await stopServer();
  await new Promise((r) => setTimeout(r, 1500));
  startServer();
  await waitForServer();
  await expectMarker(page, '서버가 죽었다 살아나면 자동 재연결로 화면이 돌아온다', 15000);

} catch (error) {
  failures++;
  console.log(`  FAIL  ${error.message}`);
} finally {
  try { await browser?.close(); } catch {}
  // 실패한 런이 holder를 유출하지 않도록 정리는 무조건 실행한다.
  for (const s of createdSessions) await destroySession(s);
  await stopServer();
  rmSync(HOME, { recursive: true, force: true });
}

console.log(failures === 0 ? 'e2e-refresh: ALL PASS' : `e2e-refresh: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
