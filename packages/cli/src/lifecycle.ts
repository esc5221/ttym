import { spawn, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
const __dirname = dirname(fileURLToPath(import.meta.url));
import { readPid, GLOBAL, EXIT, getPort, apiBase, legacyBody, fetchJson, fetchPatch, fetchPost, fetchDelete, fetchRequest, ensureCompatibleServer, hasFlag, readOption, printOutput, encodeFrame, encodeDataFrame, decodeFrame, parseFrameJson, CMD, encoder, decoder, HOME_DIR, PID_FILE, LOG_FILE, SERVER_JS, HOLDER_BIN, HTTP_TIMEOUT_MS, ATTACH_RETRY_MS, DETACH_KEY } from './common.js';
// 이 파일은 C4b 분할로 main.ts에서 나왔다 — 동작 이동 없음, 구조 이동만.
import {} from './common.js';
// ───── Commands ─────

/** 서버가 없으면 조용히 띄운다 — 진입 동사(attach/new/split)의 게으른 자동 기동.
 *  조회 동사들의 exit 4 계약은 건드리지 않는다: 이 함수는 진입 경로에서만 불린다. */
export async function ensureServerRunning(port) {
  try {
    const res = await fetch(`${apiBase(port)}/api/version`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) return false;
  } catch {}
  if (!existsSync(SERVER_JS)) {
    console.error(`server not found: ${SERVER_JS} — run scripts/build.sh first`);
    process.exit(EXIT.FAIL);
  }
  mkdirSync(HOME_DIR, { recursive: true });
  const logFd = openSync(LOG_FILE, 'a');
  const child = spawn('node', [SERVER_JS], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, PORT: String(port), TTYM_HOLDER_BIN: process.env.TTYM_HOLDER_BIN || HOLDER_BIN },
  });
  child.unref();
  writeFileSync(PID_FILE, String(child.pid));
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    try {
      const res = await fetch(`${apiBase(port)}/api/version`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        console.error(`ttym server started (pid ${child.pid}, port ${port})`);
        return true;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  console.error(`server failed to start — see ${LOG_FILE}`);
  process.exit(EXIT.NO_SERVER);
}

export function cmdStart() {
  const pid = readPid();
  if (pid) {
    console.log(`ttym already running (pid ${pid})`);
    process.exit(EXIT.FAIL);
  }

  if (!existsSync(SERVER_JS)) {
    console.error(`server not found: ${SERVER_JS}`);
    console.error('run scripts/build.sh first');
    process.exit(EXIT.FAIL);
  }

  mkdirSync(HOME_DIR, { recursive: true });

  const port = getPort();
  const logFd = openSync(LOG_FILE, 'a');

  const bind = readOption(process.argv.slice(3), '--bind');
  const env = {
    ...process.env,
    PORT: String(port),
    ...(bind ? { TTYM_BIND: bind } : {}),
    // Default to the holder next to this CLI so the two stay in step, but let
    // an explicit TTYM_HOLDER_BIN win — session.ts already honours it, and
    // overwriting it here silently ignored anyone pinning a specific holder
    // (a dev server, or a cross-version check against the installed one).
    TTYM_HOLDER_BIN: process.env.TTYM_HOLDER_BIN || HOLDER_BIN,
  };

  const child = spawn('node', [SERVER_JS], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env,
  });
  child.unref();

  // Write PID file immediately (don't wait for server boot)
  writeFileSync(PID_FILE, String(child.pid));

  console.log(`ttym started (pid ${child.pid}, port ${port})`);
  console.log(`log: ${LOG_FILE}`);
}

function waitForExit(pid, maxMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try { process.kill(pid, 0); } catch { return true; }
    execSync('sleep 0.1');
  }
  return false;
}

/**
 * Signal a pid, treating "already gone" as success.
 *
 * Every alive-check-then-kill here races the process's own exit: it can die
 * between the two calls, and the bare ESRCH used to escape as a stack trace
 * (seen during the b45f036e restart). Gone is what we wanted anyway.
 */
function signalSafe(pid, sig) {
  try { process.kill(pid, sig); return true; } catch { return false; }
}

export function cmdStop() {
  const pid = readPid();
  if (!pid) {
    console.log('ttym is not running');
    process.exit(EXIT.FAIL);
  }
  signalSafe(pid, 'SIGTERM');
  waitForExit(pid);
  console.log(`ttym stopped (pid ${pid})`);
}

export function cmdRestart() {
  const pid = readPid();
  if (pid) {
    signalSafe(pid, 'SIGTERM');
    if (!waitForExit(pid)) {
      console.error(`failed to stop pid ${pid}, force killing`);
      signalSafe(pid, 'SIGKILL');
      waitForExit(pid, 2000);
    }
  }

  // A supervised server (launchd KeepAlive in production) is respawned the
  // moment it dies. Starting our own on top of that races two servers for the
  // same holders — the race that lost session 973. If a new pid shows up on
  // its own, report it and stand down.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const fresh = readPid();
    if (fresh && fresh !== pid) {
      console.log(`ttym restarted by its service manager (pid ${fresh})`);
      return;
    }
    execSync('sleep 0.1');
  }
  cmdStart();
}

export async function cmdStatus() {
  const pid = readPid();
  if (!pid) {
    console.log('ttym is not running');
    process.exit(EXIT.NO_SERVER); // status는 질문 — "안 떠있음"은 분기 가능한 답이어야 한다
  }

  const port = getPort();
  console.log(`ttym running (pid ${pid}, port ${port})`);

  try {
    const sessions = await fetchJson(port, '/api/sessions');
    if (Array.isArray(sessions)) {
      console.log(`sessions: ${sessions.length}`);
      for (const s of sessions) {
        const status = s.status === 'attached' ? 'attached' : s.status === 'dead' ? 'dead' : 'detached';
        console.log(`  #${s.id} [${status}] ${s.cmd.join(' ')} (${s.cols}x${s.rows})`);
      }
    }
  } catch {
    console.log('sessions: (could not fetch)');
  }
}
export function cmdLog() {
  if (!existsSync(LOG_FILE)) {
    console.log('no log file');
    process.exit(EXIT.FAIL);
  }
  const follow = process.argv.includes('-f');
  const args = follow ? ['-f', LOG_FILE] : ['-50', LOG_FILE];
  const tail = spawn('tail', args, { stdio: 'inherit' });
  tail.on('exit', (code) => process.exit(code ?? 0));
}
