#!/usr/bin/env node

import { spawn, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import wsPkg from 'ws';
import { request as apiRequest, ApiError } from '@ttym/api';
import { API_VERSION, isRuntimeMetaKey } from '@ttym/protocol';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { WebSocket } = wsPkg;
const HOME_DIR = process.env.TTYM_HOME
  ? resolve(process.env.TTYM_HOME)
  : resolve(process.env.HOME || '/tmp', '.ttym');
const PID_FILE = resolve(HOME_DIR, 'ttym.pid');
const LOG_FILE = resolve(HOME_DIR, 'ttym.log');
const SERVER_JS = resolve(__dirname, 'ttym-server.js');
const HOLDER_BIN = resolve(__dirname, 'ttym-holder');
const HTTP_TIMEOUT_MS = parseInt(process.env.TTYM_HTTP_TIMEOUT_MS || '5000', 10);
const ATTACH_RETRY_MS = parseInt(process.env.TTYM_ATTACH_RETRY_MS || '1000', 10);
const DETACH_KEY = '\u001d';

const CMD = {
  DATA: 0x00,
  RESIZE: 0x01,
  CREATE: 0x02,
  DESTROY: 0x03,
  PAUSE: 0x04,
  RESUME: 0x05,
  HELLO: 0x06,
  LIST: 0x07,
  ATTACH: 0x08,
  DETACH: 0x09,
  SNAPSHOT: 0x0a,
  ACK: 0x0b,
  PAUSE_VIEW: 0x0c,
  RESUME_VIEW: 0x0d,
};
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ───── Helpers ─────

function readPid() {
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (isNaN(pid)) return null;
    // Check if process is alive
    try { process.kill(pid, 0); return pid; } catch { return null; }
  } catch {
    return null;
  }
}

/**
 * 전역 플래그 선추출 — --port·--json은 argv 어디에 있든 여기서 먼저 빠진다.
 * 이게 없던 시절 `add --cmd claude --port 7692`는 --port를 claude의 인자로
 * 넘겨 즉사시켰고(탐욕적 --cmd), `ttym --port N <cmd>`는 디스패치가 깨졌다.
 * `--` 뒤는 원문 보존 — 데이터와 하위 명령의 영토다.
 */
const GLOBAL = { port: null, json: false };
{
  const argv = process.argv;
  const kept = argv.slice(0, 2);
  let passthrough = false;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (passthrough) { kept.push(a); continue; }
    if (a === '--') { passthrough = true; kept.push(a); continue; }
    if (a === '--port' && argv[i + 1] && /^\d+$/.test(argv[i + 1])) { GLOBAL.port = parseInt(argv[i + 1], 10); i++; continue; }
    if (a === '--json') { GLOBAL.json = true; continue; }
    kept.push(a);
  }
  process.argv = kept;
}

/**
 * Exit code contract — the contract suite asserts these, scripts branch on
 * them. One number per *question the caller asks*, not per failure site:
 *   0 성공 · 1 일반 실패 · 2 usage · 3 대상 해석 실패(없음·모호)
 *   4 서버 연결 불가 · 5 API 버전 불일치
 */
const EXIT = { OK: 0, FAIL: 1, USAGE: 2, NOT_FOUND: 3, NO_SERVER: 4, VERSION: 5 };

function getPort() {
  if (GLOBAL.port !== null) return GLOBAL.port;
  return parseInt(process.env.PORT || '7690', 10);
}

const apiBase = (port) => `http://127.0.0.1:${port}`;

/** The old helpers resolved the parsed body no matter the status; keep that. */
function legacyBody(err) {
  if (err instanceof ApiError) {
    try { return JSON.parse(err.body); } catch { return null; }
  }
  throw err;
}

async function fetchJson(port, path) {
  try {
    return await apiRequest(apiBase(port), path, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch (err) { return legacyBody(err); }
}

function fetchPatch(port, path, body) {
  return fetchRequest(port, 'PATCH', path, body);
}

function fetchPost(port, path, body) {
  return fetchRequest(port, 'POST', path, body);
}

function fetchDelete(port, path) {
  return fetchRequest(port, 'DELETE', path);
}

async function fetchRequest(port, method, path, body = undefined, timeoutMs = HTTP_TIMEOUT_MS) {
  try {
    return await apiRequest(apiBase(port), path, { method, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) { return legacyBody(err); }
}

/**
 * Refuse to run against a server speaking a different API version.
 *
 * A v2 CLI against a v3 server ran for hours during the last swap with no way
 * to tell — commands half-worked and the failures looked like bugs elsewhere.
 * A server too old to have /api/version gets a warning, not an error, since
 * every pre-version server is in that state.
 */
let versionChecked = false;
async function ensureCompatibleServer(port) {
  if (versionChecked) return;
  versionChecked = true;
  let info = null;
  try {
    info = await apiRequest(apiBase(port), '/api/version', { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch (err) {
    if (err instanceof ApiError) {
      console.error('warning: server predates version reporting; upgrade it when convenient');
      return;
    }
    return; // unreachable server: let the command fail with its own message
  }
  if (info && typeof info.apiVersion === 'number' && info.apiVersion !== API_VERSION) {
    console.error(`error: server speaks api v${info.apiVersion}, this CLI speaks v${API_VERSION}`);
    console.error('       restart the server from the same build as this CLI');
    process.exit(EXIT.VERSION);
  }
}

function hasFlag(flag) {
  if (flag === '--json') return GLOBAL.json;
  return process.argv.includes(flag);
}

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

function printOutput(value, asJson = false) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  console.log(value);
}

function encodeFrame(sessionId, cmd, payload: Uint8Array = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const frame = Buffer.allocUnsafe(3 + body.length);
  frame.writeUInt16LE(sessionId, 0);
  frame[2] = cmd;
  if (body.length > 0) body.copy(frame, 3);
  return frame;
}

function encodeDataFrame(sessionId, seq, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const frame = Buffer.allocUnsafe(7 + body.length);
  frame.writeUInt16LE(sessionId, 0);
  frame[2] = CMD.DATA;
  frame.writeUInt32LE(seq, 3);
  body.copy(frame, 7);
  return frame;
}

function decodeFrame(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const sessionId = buf.readUInt16LE(0);
  const cmd = buf[2];
  if ((cmd === CMD.DATA || cmd === CMD.SNAPSHOT) && buf.length >= 7) {
    return {
      sessionId,
      cmd,
      seq: buf.readUInt32LE(3),
      payload: buf.subarray(7),
    };
  }
  return {
    sessionId,
    cmd,
    payload: buf.subarray(3),
  };
}

function parseFrameJson(payload) {
  try {
    return JSON.parse(decoder.decode(payload));
  } catch {
    return null;
  }
}

// ───── Commands ─────

function cmdStart() {
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

  const env = {
    ...process.env,
    PORT: String(port),
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

function cmdStop() {
  const pid = readPid();
  if (!pid) {
    console.log('ttym is not running');
    process.exit(EXIT.FAIL);
  }
  signalSafe(pid, 'SIGTERM');
  waitForExit(pid);
  console.log(`ttym stopped (pid ${pid})`);
}

function cmdRestart() {
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

async function cmdStatus() {
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

function parsePrefixKey(spec) {
  if (!spec) return 0x02; // default C-b
  const m = String(spec).toLowerCase().match(/^(c-|ctrl-|\^)([a-z\[\\\]])$/);
  if (!m) {
    console.error(`invalid prefix key: ${spec} (expected C-<letter>)`);
    process.exit(EXIT.USAGE);
  }
  const ch = m[2];
  if (ch >= 'a' && ch <= 'z') return ch.charCodeAt(0) - 96;
  if (ch === '[') return 27;
  if (ch === '\\') return 28;
  if (ch === ']') return 29;
  return 0x02;
}

function prefixLabel(b) {
  if (b >= 1 && b <= 26) return `C-${String.fromCharCode(b + 96)}`;
  if (b === 27) return 'C-[';
  if (b === 28) return 'C-\\';
  if (b === 29) return 'C-]';
  return `0x${b.toString(16)}`;
}

async function cmdAttach() {
  const raw = process.argv.slice(3);
  const cmdIdx = raw.indexOf('--cmd');
  const head = cmdIdx !== -1 ? raw.slice(0, cmdIdx) : raw;
  const tailCmd = cmdIdx !== -1
    ? raw.slice(cmdIdx + 1).filter((v) => v !== '--json')
    : null;

  let readonly = false;
  let createNew = false;
  let cwd = null;
  let role = null;
  let memberName = null;
  let prefixSpec = process.env.TTYM_PREFIX || null;
  const positional = [];

  for (let i = 0; i < head.length; i += 1) {
    const arg = head[i];
    if (arg === '--json') continue;
    if (arg === '--readonly') { readonly = true; continue; }
    if (arg === '--new') { createNew = true; continue; }
    if (arg === '--cwd') { cwd = head[++i] ?? null; continue; }
    if (arg === '--role') { role = head[++i] ?? null; continue; }
    if (arg === '--name') { memberName = head[++i] ?? null; continue; }
    if (arg === '--prefix') { prefixSpec = head[++i] ?? null; continue; }
    if (arg.startsWith('--')) {
      console.error(`unknown option: ${arg}`);
      process.exit(EXIT.USAGE);
    }
    positional.push(arg);
  }

  const targetToken = positional[0];
  if (!targetToken) {
    console.error('usage: ttym attach <session-id|project/workspace/member|workspace/member>');
    console.error('            [--readonly] [--prefix C-<key>]');
    console.error('            [--new [--cmd <cmd...>] [--cwd <path>] [--role <role>] [--name <name>]]');
    process.exit(EXIT.USAGE);
  }
  const prefixByte = parsePrefixKey(prefixSpec);
  const pfxLabel = prefixLabel(prefixByte);
  const port = getPort();
  let currentTarget = await resolveAttachTarget(port, targetToken, {
    createIfMissing: createNew,
    createOptions: { name: memberName, role, cmd: tailCmd, cwd },
  });
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('ttym attach requires an interactive TTY');
    process.exit(EXIT.FAIL);
  }
  const attachMode = readonly ? 'readonly' : 'readwrite';
  const wsUrl = `ws://127.0.0.1:${port}/ws`;

  let ws = null;
  let connected = false;
  let detached = false;
  let closed = false;
  let reconnectTimer = null;
  let restoreTty = null;
  let lastSeq = 0;
  let lastInfo = null;
  let statusMessage = '';

  // mode: 'attached' | 'prefix' | 'picker' | 'help'
  let uiMode = 'attached';
  let prefixTimer = null;
  let picker = null;

  function writeStdout(data) {
    try { process.stdout.write(data); } catch {}
  }

  function showStatus(text) {
    statusMessage = text;
    writeStdout(`\r\n\x1b[2m[ttym] ${text}\x1b[0m\r\n`);
  }

  function applySnapshot(snapshot) {
    writeStdout('\x1b[?25l\x1b[H\x1b[2J');
    writeStdout(snapshot);
    writeStdout('\x1b[?25h');
  }

  function sendFrame(frame) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(frame);
  }

  function sendHello() {
    sendFrame(encodeFrame(0, CMD.HELLO, encoder.encode(JSON.stringify({ clientId: randomUUID() }))));
  }

  function sendAttach() {
    sendFrame(encodeFrame(currentTarget.sessionId, CMD.ATTACH, encoder.encode(JSON.stringify({
      fromSeq: lastSeq,
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
      mode: attachMode,
    }))));
  }

  function sendDetachCurrent() {
    sendFrame(encodeFrame(currentTarget.sessionId, CMD.DETACH));
  }

  function sendResize() {
    const cols = process.stdout.columns || lastInfo?.cols || 80;
    const rows = process.stdout.rows || lastInfo?.rows || 24;
    const payload = Buffer.allocUnsafe(4);
    payload.writeUInt16LE(cols, 0);
    payload.writeUInt16LE(rows, 2);
    sendFrame(encodeFrame(currentTarget.sessionId, CMD.RESIZE, payload));
  }

  function scheduleReconnect() {
    if (detached || closed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, ATTACH_RETRY_MS);
  }

  function cleanup(exitCode = 0) {
    if (closed) return;
    closed = true;
    detached = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (prefixTimer) clearTimeout(prefixTimer);
    reconnectTimer = null;
    prefixTimer = null;
    process.stdin.off('data', onInput);
    process.stdout.off('resize', onResize);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (ws) { try { ws.close(); } catch {} ws = null; }
    if (restoreTty) restoreTty();
    if (statusMessage) writeStdout('\r\n');
    process.exit(exitCode);
  }

  function onSignal() {
    detached = true;
    try { sendDetachCurrent(); } catch {}
    cleanup(0);
  }

  function onResize() {
    if (!connected) return;
    if (attachMode === 'readwrite') sendResize();
    if (uiMode === 'picker') renderPicker();
    if (uiMode === 'help') renderHelp();
  }

  function enterPrefix() {
    uiMode = 'prefix';
    if (prefixTimer) clearTimeout(prefixTimer);
    prefixTimer = setTimeout(() => {
      if (uiMode === 'prefix') uiMode = 'attached';
      prefixTimer = null;
    }, 1500);
  }

  function exitPrefix() {
    if (prefixTimer) { clearTimeout(prefixTimer); prefixTimer = null; }
    if (uiMode === 'prefix') uiMode = 'attached';
  }

  async function switchTarget(nextTarget) {
    if (nextTarget.sessionId === currentTarget.sessionId) {
      // force resnap
      sendDetachCurrent();
      lastSeq = 0;
      sendAttach();
      return;
    }
    sendDetachCurrent();
    currentTarget = nextTarget;
    lastSeq = 0;
    sendAttach();
  }

  async function collectEntries() {
    const workspaces = await listWorkspaces(port);
    const entries = [];
    for (const ws of workspaces) {
      for (const m of ws.members || []) {
        entries.push({
          sessionId: m.sessionId,
          label: memberAddress(ws, m),
          workspace: ws,
          member: m,
        });
      }
    }
    return entries;
  }

  async function enterPicker() {
    if (prefixTimer) { clearTimeout(prefixTimer); prefixTimer = null; }
    uiMode = 'picker';
    picker = { entries: [], cursor: 0 };
    renderPicker();
    const entries = await collectEntries();
    if (uiMode !== 'picker') return;
    if (entries.length === 0) {
      uiMode = 'attached';
      picker = null;
      showStatus('no workspace members to pick');
      sendDetachCurrent(); lastSeq = 0; sendAttach();
      return;
    }
    const currentIndex = entries.findIndex((e) => e.sessionId === currentTarget.sessionId);
    picker = {
      entries,
      cursor: currentIndex >= 0 ? currentIndex : 0,
    };
    renderPicker();
  }

  function renderPicker() {
    if (!picker) return;
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    writeStdout('\x1b[?25l\x1b[H\x1b[2J');
    const header = `[ttym] session picker  (j/k move, Enter select, Esc cancel, q quit)`;
    writeStdout(`\x1b[1m${header.slice(0, cols)}\x1b[0m\r\n\r\n`);
    if (!picker.entries || picker.entries.length === 0) {
      writeStdout('  (loading...)\r\n');
      return;
    }
    const reserved = 3;
    const capacity = Math.max(1, rows - reserved);
    const total = picker.entries.length;
    let top = 0;
    if (total > capacity) {
      top = Math.max(0, Math.min(total - capacity, picker.cursor - Math.floor(capacity / 2)));
    }
    for (let row = 0; row < capacity && top + row < total; row += 1) {
      const i = top + row;
      const e = picker.entries[i];
      const selected = i === picker.cursor;
      const marker = selected ? '▶' : ' ';
      const current = e.sessionId === currentTarget.sessionId ? ' *' : '  ';
      let line = `${marker} ${e.label} #${e.sessionId}${current}`;
      if (line.length > cols) line = line.slice(0, cols - 1) + '…';
      if (selected) writeStdout(`\x1b[7m${line.padEnd(cols)}\x1b[0m\r\n`);
      else writeStdout(`${line}\r\n`);
    }
  }

  function movePicker(delta) {
    if (!picker || picker.entries.length === 0) return;
    const n = picker.entries.length;
    picker.cursor = ((picker.cursor + delta) % n + n) % n;
    renderPicker();
  }

  function exitPicker(selected) {
    const chosen = selected ? picker.entries[picker.cursor] : null;
    picker = null;
    uiMode = 'attached';
    if (chosen) {
      void switchTarget({
        sessionId: chosen.sessionId,
        label: chosen.label,
        workspace: chosen.workspace,
        member: chosen.member,
      });
    } else {
      // cancel → resnap current
      sendDetachCurrent(); lastSeq = 0; sendAttach();
    }
  }

  async function cycleMember(delta) {
    exitPrefix();
    const entries = await collectEntries();
    if (entries.length < 2) return;
    let idx = entries.findIndex((e) => e.sessionId === currentTarget.sessionId);
    if (idx < 0) idx = 0;
    idx = ((idx + delta) % entries.length + entries.length) % entries.length;
    const e = entries[idx];
    await switchTarget({ sessionId: e.sessionId, label: e.label, workspace: e.workspace, member: e.member });
  }

  function renderHelp() {
    const cols = process.stdout.columns || 80;
    writeStdout('\x1b[?25l\x1b[H\x1b[2J');
    const lines = [
      `\x1b[1m[ttym] keybindings (prefix: ${pfxLabel})\x1b[0m`,
      '',
      `  ${pfxLabel} d       detach`,
      `  ${pfxLabel} s       session picker`,
      `  ${pfxLabel} n       next workspace member`,
      `  ${pfxLabel} p       previous workspace member`,
      `  ${pfxLabel} ?       this help`,
      `  ${pfxLabel} ${pfxLabel}     send prefix to inner`,
      '',
      '  C-]             detach (alt)',
      '',
      '  press any key to return',
    ];
    for (const l of lines) writeStdout(l.slice(0, cols) + '\r\n');
  }

  function exitHelp() {
    uiMode = 'attached';
    sendDetachCurrent(); lastSeq = 0; sendAttach();
  }

  function handlePrefixKey(data) {
    exitPrefix();
    if (data.length !== 1) return;
    const b = data[0];
    if (b === prefixByte) {
      // prefix prefix → send to PTY
      sendFrame(encodeFrame(currentTarget.sessionId, CMD.DATA, data));
      return;
    }
    if (b === 0x64) { // d
      detached = true;
      sendDetachCurrent();
      cleanup(0);
      return;
    }
    if (b === 0x73) { void enterPicker(); return; } // s
    if (b === 0x6e) { void cycleMember(+1); return; } // n
    if (b === 0x70) { void cycleMember(-1); return; } // p
    if (b === 0x3f) { uiMode = 'help'; renderHelp(); return; } // ?
    // unknown → drop
  }

  function handlePickerKey(data) {
    let i = 0;
    while (i < data.length) {
      // CSI sequence: ESC [ X
      if (data[i] === 0x1b && data[i + 1] === 0x5b && i + 2 < data.length) {
        const ready = picker && picker.entries && picker.entries.length > 0;
        if (ready) {
          if (data[i + 2] === 0x41) movePicker(-1);
          else if (data[i + 2] === 0x42) movePicker(+1);
        }
        i += 3;
        continue;
      }
      const b = data[i];
      if (b === 0x1b || b === 0x71 || b === 0x03) { exitPicker(false); return; }
      const ready = picker && picker.entries && picker.entries.length > 0;
      if (!ready) { i += 1; continue; }
      if (b === 0x0d || b === 0x0a) { exitPicker(true); return; }
      if (b === 0x6a || b === 0x0e) movePicker(+1);
      else if (b === 0x6b || b === 0x10) movePicker(-1);
      else if (b === 0x67) { picker.cursor = 0; renderPicker(); }
      else if (b === 0x47) { picker.cursor = picker.entries.length - 1; renderPicker(); }
      i += 1;
      if (closed || uiMode !== 'picker') return;
    }
  }

  function onInput(chunk) {
    const data = Buffer.from(chunk);
    if (uiMode === 'picker') { handlePickerKey(data); return; }
    if (uiMode === 'help') { exitHelp(); return; }
    if (uiMode === 'prefix') { handlePrefixKey(data); return; }

    // attached mode
    if (!readonly && data.length === 1 && data[0] === 0x1d) {
      detached = true;
      sendDetachCurrent();
      cleanup(0);
      return;
    }
    if (!readonly && data.length === 1 && data[0] === prefixByte) {
      enterPrefix();
      return;
    }
    if (readonly) return;
    sendFrame(encodeFrame(currentTarget.sessionId, CMD.DATA, data));
  }

  function connect() {
    if (closed || detached) return;
    showStatus(connected ? `reconnecting ${currentTarget.label}` : `connecting ${currentTarget.label}`);
    ws = new WebSocket(wsUrl);
    ws.binaryType = 'nodebuffer';

    ws.on('open', () => {
      connected = true;
      sendHello();
      sendAttach();
    });

    ws.on('message', (rawMsg) => {
      const frame = decodeFrame(rawMsg);
      if (frame.sessionId !== currentTarget.sessionId && frame.sessionId !== 0) return;

      if (frame.cmd === CMD.ATTACH) {
        const meta = parseFrameJson(frame.payload);
        if (!meta?.ok) {
          showStatus(meta?.error || 'attach failed');
          detached = true;
          cleanup(1);
          return;
        }
        lastInfo = meta;
        lastSeq = typeof meta.lastSeq === 'number' ? meta.lastSeq : lastSeq;
        if (uiMode === 'attached') {
          const suffix = attachMode === 'readonly' ? '(readonly)' : `(prefix: ${pfxLabel}, ${pfxLabel} d=detach ${pfxLabel} s=picker ${pfxLabel} ?=help)`;
          showStatus(`${currentTarget.label} attached ${suffix}`);
        }
        if (attachMode === 'readwrite') sendResize();
        return;
      }

      if (frame.cmd === CMD.SNAPSHOT) {
        if (typeof frame.seq === 'number') lastSeq = frame.seq;
        if (uiMode === 'attached') applySnapshot(decoder.decode(frame.payload));
        return;
      }

      if (frame.cmd === CMD.DATA) {
        if (typeof frame.seq === 'number') {
          lastSeq = frame.seq;
          sendFrame(encodeFrame(currentTarget.sessionId, CMD.ACK, encoder.encode(JSON.stringify({ seq: frame.seq }))));
        }
        if (uiMode === 'attached') writeStdout(frame.payload);
        return;
      }

      if (frame.cmd === CMD.DESTROY) {
        showStatus(`${currentTarget.label} exited`);
        detached = true;
        cleanup(0);
      }
    });

    ws.on('close', () => {
      connected = false;
      if (closed || detached) return;
      showStatus(`connection lost, retrying in ${ATTACH_RETRY_MS}ms`);
      scheduleReconnect();
    });

    ws.on('error', () => {
      connected = false;
    });
  }

  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', onInput);
  process.stdout.on('resize', onResize);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  restoreTty = () => {
    if (process.stdin.isTTY) process.stdin.setRawMode(Boolean(wasRaw));
  };

  connect();
}

function cmdLog() {
  if (!existsSync(LOG_FILE)) {
    console.log('no log file');
    process.exit(EXIT.FAIL);
  }
  const follow = process.argv.includes('-f');
  const args = follow ? ['-f', LOG_FILE] : ['-50', LOG_FILE];
  const tail = spawn('tail', args, { stdio: 'inherit' });
  tail.on('exit', (code) => process.exit(code ?? 0));
}

async function cmdMeta() {
  const sessionId = process.argv[3];
  if (!sessionId || isNaN(parseInt(sessionId, 10))) {
    console.error('usage: ttym meta <session-id> [--set key=value ...] [--claude-session <id>] [--claude-source <source>] [--clear-claude-session [id]] [--codex-session <id>] [--clear-codex-session [id]]');
    process.exit(EXIT.USAGE);
  }
  const id = parseInt(sessionId, 10);
  const port = getPort();
  await ensureCompatibleServer(port);
  const now = new Date().toISOString();

  // Collect --set key=value pairs and --claude-session shorthand
  const patch: Record<string, unknown> = {};
  let hasPatch = false;
  const args = process.argv.slice(4);
  let pendingClaudeSource = null;
  let pendingCodexSource = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--set' && args[i + 1]) {
      const [k, ...vParts] = args[i + 1].split('=');
      if (k && vParts.length > 0) {
        patch[k] = vParts.join('=');
        hasPatch = true;
      }
      i++;
    } else if (args[i] === '--claude-session' && args[i + 1]) {
      patch.claudeSessionId = args[i + 1];
      patch.claudeLastSessionId = args[i + 1];
      patch.claudeActive = true;
      patch.claudeLastStartedAt = now;
      patch.claudeLastStoppedAt = null;
      if (pendingClaudeSource) patch.claudeSessionSource = pendingClaudeSource;
      hasPatch = true;
      i++;
    } else if (args[i] === '--claude-source' && args[i + 1]) {
      pendingClaudeSource = args[i + 1];
      patch.claudeSessionSource = pendingClaudeSource;
      hasPatch = true;
      i++;
    } else if (args[i] === '--clear-claude-session') {
      const expectedId = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
      patch.claudeSessionId = null;
      patch.claudeActive = false;
      patch.claudeLastStoppedAt = now;
      if (expectedId) {
        patch.claudeLastSessionId = expectedId;
        i++;
      }
      hasPatch = true;
    } else if (args[i] === '--codex-session' && args[i + 1]) {
      patch.codexSessionId = args[i + 1];
      patch.codexLastSessionId = args[i + 1];
      patch.codexActive = true;
      patch.codexLastStartedAt = now;
      patch.codexLastStoppedAt = null;
      if (pendingCodexSource) patch.codexSessionSource = pendingCodexSource;
      hasPatch = true;
      i++;
    } else if (args[i] === '--codex-source' && args[i + 1]) {
      pendingCodexSource = args[i + 1];
      patch.codexSessionSource = pendingCodexSource;
      hasPatch = true;
      i++;
    } else if (args[i] === '--clear-codex-session') {
      const expectedId = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
      patch.codexSessionId = null;
      patch.codexActive = false;
      patch.codexLastStoppedAt = now;
      if (expectedId) {
        patch.codexLastSessionId = expectedId;
        i++;
      }
      hasPatch = true;
    }
  }

  try {
    if (hasPatch) {
      // Runtime keys (the agent mapping the hooks maintain) are server-owned
      // and travel through the internal endpoint; the public PATCH rejects
      // them. Annotations keep going through the public surface. One command
      // can carry both, so the patch is split.
      const runtime = {};
      const annotations = {};
      for (const [key, value] of Object.entries(patch)) {
        (isRuntimeMetaKey(key) ? runtime : annotations)[key] = value;
      }
      let result = null;
      if (Object.keys(runtime).length > 0) {
        result = await fetchPost(port, `/api/internal/sessions/${id}/agent`, runtime);
        // A pre-split server has no internal endpoint but accepts runtime keys
        // on the public PATCH; fall back so the hooks keep working against it.
        if (result && result.error) {
          result = await fetchPatch(port, `/api/sessions/${id}/meta`, runtime);
        }
      }
      if (Object.keys(annotations).length > 0) {
        result = await fetchPatch(port, `/api/sessions/${id}/meta`, annotations);
      }
      console.log(JSON.stringify(result, null, 2));
    } else {
      const result = await fetchJson(port, `/api/sessions/${id}/meta`);
      console.log(JSON.stringify(result, null, 2));
    }
  } catch {
    console.error('failed to connect to ttym server');
    process.exit(EXIT.NO_SERVER);
  }
}

async function listProjects(port) {
  return await fetchJson(port, '/api/projects');
}

async function listWorkspaces(port, project = null) {
  const suffix = project ? `?project=${encodeURIComponent(project)}` : '';
  return await fetchJson(port, `/api/workspaces${suffix}`);
}

async function getWorkspaceById(port, id) {
  return await fetchJson(port, `/api/workspaces/${encodeURIComponent(id)}`);
}

function normalizeAddressToken(value) {
  if (!value) return null;
  return value.replace(/^\/+|\/+$/g, '');
}

function getSessionIdsFromLayout(node) {
  if (!node) return [];
  if (node.type === 'pane') return node.sessionId > 0 ? [node.sessionId] : [];
  return Array.isArray(node.children) ? node.children.flatMap(getSessionIdsFromLayout) : [];
}

function findWorkspaceBySessionId(workspaces, sessionId) {
  return workspaces.find((workspace) => getSessionIdsFromLayout(workspace.layout).includes(sessionId)) || null;
}

async function resolveCurrentWorkspace(port) {
  const sid = process.env.TTYM_SESSION_ID;
  if (!sid || isNaN(parseInt(sid, 10))) {
    console.error('current workspace resolution requires TTYM_SESSION_ID');
    process.exit(EXIT.FAIL);
  }
  const sessionId = parseInt(sid, 10);
  const workspaces = await listWorkspaces(port);
  const workspace = findWorkspaceBySessionId(workspaces, sessionId);
  if (!workspace) {
    console.error(`current session #${sessionId} is not assigned to a workspace`);
    process.exit(EXIT.NOT_FOUND);
  }
  return workspace;
}

async function resolveWorkspace(port, token) {
  if (!token || token === '--current') {
    return resolveCurrentWorkspace(port);
  }

  const normalized = normalizeAddressToken(token);
  if (!normalized) {
    console.error('workspace target is required');
    process.exit(EXIT.USAGE);
  }

  const direct = await getWorkspaceById(port, normalized);
  if (direct?.id) return direct;

  const workspaces = await listWorkspaces(port);
  const slash = normalized.indexOf('/');
  if (slash !== -1) {
    const [project, name] = [normalized.slice(0, slash), normalized.slice(slash + 1)];
    const match = workspaces.find((workspace) => workspace.project === project && workspace.name === name);
    if (match) return match;
  } else {
    const exact = workspaces.filter((workspace) => workspace.name === normalized);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) {
      console.error(`workspace name is ambiguous: ${normalized}`);
      process.exit(EXIT.NOT_FOUND);
    }
  }

  console.error(`workspace not found: ${token}`);
  process.exit(EXIT.NOT_FOUND);
}

async function resolveAttachTarget(port, token, options: Record<string, any> = {}) {
  const { createIfMissing = false, createOptions = {} } = options;
  const normalized = normalizeAddressToken(token);
  if (!normalized) {
    console.error('attach target is required');
    process.exit(EXIT.USAGE);
  }

  if (/^\d+$/.test(normalized)) {
    if (createIfMissing) {
      console.error('--new requires a workspace/member address, not a raw session id');
      process.exit(EXIT.USAGE);
    }
    const sessionId = parseInt(normalized, 10);
    return {
      sessionId,
      label: `#${sessionId}`,
      workspace: null,
      member: null,
    };
  }

  const parts = normalized.split('/');
  let workspace = null;
  let memberToken = null;

  if (parts.length >= 3) {
    workspace = await resolveWorkspace(port, `${parts[0]}/${parts[1]}`);
    memberToken = parts.slice(2).join('/');
  } else if (parts.length === 2) {
    const [workspaceName, rest] = parts;
    const workspaces = await listWorkspaces(port);
    const matches = workspaces.filter((ws) => ws.name === workspaceName);
    if (matches.length > 1) {
      console.error(`workspace name is ambiguous: ${workspaceName}`);
      process.exit(EXIT.NOT_FOUND);
    }
    if (matches.length === 1) {
      workspace = matches[0];
      memberToken = rest;
    }
  }

  if (!workspace) {
    console.error(`attach target not found: ${token}`);
    process.exit(EXIT.NOT_FOUND);
  }

  const existing = findMemberInWorkspace(workspace, memberToken);
  if (existing) {
    return {
      sessionId: existing.sessionId,
      label: memberAddress(workspace, existing),
      workspace,
      member: existing,
    };
  }

  if (!createIfMissing) {
    console.error(`member not found: ${memberToken}`);
    process.exit(EXIT.NOT_FOUND);
  }

  if (/^\d+$/.test(normalizeAddressToken(memberToken) || '')) {
    console.error('--new requires a member name, not a session id');
    process.exit(EXIT.USAGE);
  }

  const created = await createWorkspaceMember(port, workspace, {
    ...createOptions,
    name: createOptions.name || memberToken,
  });
  return {
    sessionId: created.session.id,
    label: memberAddress(created.workspace, created.member),
    workspace: created.workspace,
    member: created.member,
  };
}

function findMemberInWorkspace(workspace, token) {
  const normalized = normalizeAddressToken(token);
  if (!normalized) return null;
  const members = workspace.members || [];
  const byName = members.find((m) => m.name === normalized);
  if (byName) return byName;
  if (/^\d+$/.test(normalized)) {
    const sid = parseInt(normalized, 10);
    return members.find((m) => m.sessionId === sid) || null;
  }
  return null;
}

async function createWorkspaceMember(port, workspace, opts: Record<string, any> = {}) {
  const { name, role = null, cmd = null, cwd = null } = opts;
  const usedNames = new Set((workspace.members || []).map((m) => m.name));
  let memberName = name;
  if (!memberName) {
    let index = 1;
    while (usedNames.has(`term-${index}`)) index += 1;
    memberName = `term-${index}`;
  } else if (usedNames.has(memberName)) {
    throw new Error(`member name already exists: ${memberName}`);
  }
  const sessionBody: Record<string, unknown> = {
    cmd: cmd && cmd.length > 0 ? cmd : [process.env.SHELL || '/bin/bash'],
    cols: 80,
    rows: 24,
    verify: true,
  };
  if (cwd) sessionBody.cwd = cwd;
  const created = await fetchPost(port, '/api/sessions', sessionBody);
  if (created.error) {
    throw new Error(created.error);
  }
  const updated = await fetchPost(port, `/api/workspaces/${encodeURIComponent(workspace.id)}/members`, {
    sessionId: created.id,
    name: memberName,
    role: role || undefined,
    tags: [],
  });
  await patchSessionMeta(port, created.id, {
    project: updated.project,
    workspaceId: updated.id,
    workspaceName: updated.name,
    memberName,
    role: role || null,
    name: memberName,
  });
  const member = updated.members.find((entry) => entry.sessionId === created.id);
  return { workspace: updated, member, session: created };
}

function requireMember(workspace, token) {
  const normalized = normalizeAddressToken(token);
  if (!normalized) {
    console.error('member target is required');
    process.exit(EXIT.USAGE);
  }

  const byName = (workspace.members || []).filter((member) => member.name === normalized);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    console.error(`member name is ambiguous: ${normalized}`);
    process.exit(EXIT.NOT_FOUND);
  }

  if (/^\d+$/.test(normalized)) {
    const sessionId = parseInt(normalized, 10);
    const byId = (workspace.members || []).find((member) => member.sessionId === sessionId);
    if (byId) return byId;
  }

  console.error(`member not found: ${token}`);
  process.exit(EXIT.NOT_FOUND);
}

async function patchSessionMeta(port, sessionId, patch) {
  return await fetchPatch(port, `/api/sessions/${sessionId}/meta`, patch);
}

function memberAddress(workspace, member) {
  return `${workspace.project}/${workspace.name}/${member.name}`;
}

async function cmdCurrent() {
  const port = getPort();
  await ensureCompatibleServer(port);
  const asJson = hasFlag('--json');
  const workspace = await resolveCurrentWorkspace(port);
  const sessionId = parseInt(process.env.TTYM_SESSION_ID, 10);
  const member = (workspace.members || []).find((entry) => entry.sessionId === sessionId) || null;
  const result = {
    project: workspace.project,
    workspace: {
      id: workspace.id,
      name: workspace.name,
      address: `${workspace.project}/${workspace.name}`,
    },
    member: member ? {
      name: member.name,
      role: member.role || null,
      sessionId: member.sessionId,
      address: memberAddress(workspace, member),
    } : null,
    sessionId,
  };
  if (asJson) return printOutput(result, true);
  console.log(`project:   ${result.project}`);
  console.log(`workspace: ${result.workspace.address}`);
  if (result.member) console.log(`member:    ${result.member.name} (#${result.member.sessionId})`);
  console.log(`session:   #${result.sessionId}`);
}

async function cmdProject() {
  const action = process.argv[3];
  const port = getPort();
  await ensureCompatibleServer(port);
  const asJson = hasFlag('--json');

  if (action === 'list') {
    const projects = await listProjects(port);
    if (asJson) return printOutput(projects, true);
    for (const project of projects) {
      console.log(`${project.name}  workspaces=${project.workspaceCount} members=${project.memberCount}`);
    }
    return;
  }

  console.log('usage: ttym project list [--json]');
  process.exit(EXIT.USAGE);
}

async function cmdWorkspace() {
  const action = process.argv[3];
  const args = process.argv.slice(4);
  const port = getPort();
  await ensureCompatibleServer(port);
  const asJson = hasFlag('--json');

  if (action === 'list') {
    const targetProject = args[0] && !args[0].startsWith('--') ? args[0] : null;
    const workspaces = await listWorkspaces(port, targetProject);
    if (asJson) return printOutput(workspaces, true);
    for (const workspace of workspaces) {
      console.log(`${workspace.project}/${workspace.name}  id=${workspace.id}  members=${workspace.members.length}`);
    }
    return;
  }

  if (action === 'info') {
    const token = args[0];
    const workspace = await resolveWorkspace(port, token);
    const result = {
      workspaceId: workspace.id,
      project: workspace.project,
      name: workspace.name,
      address: `${workspace.project}/${workspace.name}`,
      members: (workspace.members || []).map((member) => ({
        name: member.name,
        role: member.role || null,
        sessionId: member.sessionId,
        status: null,
      })),
    };
    const sessions = await fetchJson(port, '/api/sessions').catch(() => []);
    const sessionById = new Map((Array.isArray(sessions) ? sessions : []).map((session) => [session.id, session]));
    result.members = result.members.map((member) => ({
      ...member,
      status: sessionById.get(member.sessionId)?.status ?? 'missing',
      cmd: sessionById.get(member.sessionId)?.cmd ?? [],
    }));
    if (asJson) return printOutput(result, true);
    console.log(`${result.address} (${result.workspaceId})`);
    for (const member of result.members) {
      console.log(`  - ${member.name}  #${member.sessionId}  [${member.status}] ${member.cmd.join(' ')}`);
    }
    return;
  }

  if (action === 'create') {
    const project = args[0] && !args[0].startsWith('--') ? args[0] : 'default';
    const name = readOption(args, '--name');
    if (!name) {
      console.error('usage: ttym workspace create <project> --name <name> [--json]');
      process.exit(EXIT.USAGE);
    }
    const id = randomUUID().slice(0, 8);
    const workspace = await fetchPost(port, '/api/workspaces', {
      id,
      project,
      name,
      layout: { type: 'pane', sessionId: 0 },
      members: [],
    });
    if (asJson) return printOutput(workspace, true);
    console.log(`${workspace.project}/${workspace.name} (${workspace.id})`);
    return;
  }

  if (action === 'delete') {
    const workspace = await resolveWorkspace(port, args[0]);
    for (const member of workspace.members || []) {
      await fetchDelete(port, `/api/sessions/${member.sessionId}`);
    }
    await fetchDelete(port, `/api/workspaces/${encodeURIComponent(workspace.id)}`);
    if (asJson) return printOutput({ ok: true, deleted: workspace.id }, true);
    console.log(`deleted ${workspace.project}/${workspace.name}`);
    return;
  }

  if (action === 'layout') {
    const workspace = await resolveWorkspace(port, args[0]);
    const spec = args[1];
    if (!spec) {
      console.error('usage: ttym workspace layout <workspace|--current> <even-h|even-v|main-v|tiled|auto|layout-json>');
      process.exit(EXIT.USAGE);
    }
    // tmux select-layout: 프리셋 이름과 커스텀 트리를 같은 입구로 받는다.
    const presets = ['even-h', 'even-v', 'main-v', 'tiled', 'auto'];
    const patch = presets.includes(spec) ? { preset: spec } : { layout: JSON.parse(spec) };
    const next = await fetchPatch(port, `/api/workspaces/${encodeURIComponent(workspace.id)}`, patch);
    if (asJson) return printOutput(next, true);
    console.log(`${next.project}/${next.name} layout updated`);
    return;
  }

  if (action === 'rename') {
    const workspace = await resolveWorkspace(port, args[0]);
    const name = readOption(args, '--name');
    if (!name) {
      console.error('usage: ttym workspace rename <workspace|--current> --name <name>');
      process.exit(EXIT.USAGE);
    }
    const next = await fetchPatch(port, `/api/workspaces/${encodeURIComponent(workspace.id)}`, { name });
    if (asJson) return printOutput(next, true);
    console.log(`${next.project}/${next.name}`);
    return;
  }

  if (action === 'add') {
    const workspace = await resolveWorkspace(port, args[0]);
    const name = readOption(args, '--name');
    const role = readOption(args, '--role');
    const cmdIndex = args.indexOf('--cmd');
    const cmd = cmdIndex !== -1 ? args.slice(cmdIndex + 1).filter((value) => value !== '--json') : null;
    try {
      const { workspace: updated, member, session } = await createWorkspaceMember(port, workspace, {
        name, role, cmd,
      });
      const result = {
        workspace: `${updated.project}/${updated.name}`,
        member: { ...member, address: memberAddress(updated, member) },
        session,
      };
      if (asJson) return printOutput(result, true);
      console.log(`added ${result.member.address} -> #${session.id}`);
    } catch (e) {
      if (asJson) return printOutput({ error: e.message }, true);
      console.error(`workspace add failed: ${e.message}`);
      process.exit(EXIT.FAIL);
    }
    return;
  }

  if (action === 'terminate') {
    // 처음부터 remove와 동일 동작이었다(v2 잔재). 이름 하나, 동작 하나.
    console.error("`terminate` is gone — use: ttym workspace remove <workspace|--current> <member>");
    process.exit(EXIT.USAGE);
  }

  if (action === 'remove' || action === 'detach') {
    const workspace = await resolveWorkspace(port, args[0]);
    const member = requireMember(workspace, args[1]);
    await fetchDelete(port, `/api/workspaces/${encodeURIComponent(workspace.id)}/members/${member.sessionId}`);
    if (action === 'detach') {
      await patchSessionMeta(port, member.sessionId, {
        project: null,
        workspaceId: null,
        workspaceName: null,
      });
    }
    if (action === 'remove') {
      await fetchDelete(port, `/api/sessions/${member.sessionId}`);
    }
    const result = { ok: true, action, workspace: `${workspace.project}/${workspace.name}`, member: member.name, sessionId: member.sessionId };
    if (asJson) return printOutput(result, true);
    console.log(`${action}d ${workspace.project}/${workspace.name}/${member.name} (#${member.sessionId})`);
    return;
  }

  if (action === 'send') {
    const sep = args.indexOf('--');
    const payload = sep !== -1 ? args.slice(sep + 1).join(' ') : '';
    const workspace = await resolveWorkspace(port, args[0]);
    const member = requireMember(workspace, args[1]);
    if (!payload) {
      console.error('usage: ttym workspace send <workspace|--current> <member> -- "command\\n"');
      process.exit(EXIT.USAGE);
    }
    const result = await fetchPost(port, `/api/sessions/${member.sessionId}/send`, { data: payload });
    if (asJson) return printOutput(result, true);
    console.log(`sent to ${workspace.project}/${workspace.name}/${member.name}`);
    return;
  }

  if (action === 'await') {
    const workspace = await resolveWorkspace(port, args[0]);
    const member = requireMember(workspace, args[1]);
    const sep = args.indexOf('--');
    const payload = sep !== -1 ? args.slice(sep + 1).join(' ') : '';
    const timeoutMs = parseInt(readOption(args, '--timeout') || '120000', 10);

    // The server owns the request/response pairing now: it marks the buffer,
    // submits the prompt, and holds the reply until the agent's hook settles
    // it. Nothing polls, so a fast answer comes back as fast as it lands.
    const text = payload.replace(/[\r\n]+$/, '');
    // The server holds this request open until the agent's hook settles it, so
    // the socket timeout has to outlast the interaction timeout, not the
    // default 5s meant for ordinary calls.
    const response = await fetchRequest(port, 'POST', `/api/sessions/${member.sessionId}/interactions`, {
      prompt: text,
      timeoutMs,
      submit: 'cr',
    }, timeoutMs + 15_000);
    const interaction = response?.interaction ?? null;
    const completed = interaction?.status === 'completed';

    // A transcript read off a degraded screen (gap recovery, not yet
    // repainted) is approximate — say so instead of letting it pass as exact.
    if (interaction?.integrity === 'degraded') {
      process.stderr.write('warning: screen integrity is degraded — transcript may be approximate\n');
    }
    // `--raw` predates transcripts and meant "the screen with its escapes".
    // Keep that meaning, and fall back to it when the marked rows are gone.
    let output = interaction?.transcript ?? null;
    if (hasFlag('--raw') || output === null) {
      const screen = await fetchJson(port, `/api/sessions/${member.sessionId}/screen`).catch(() => null);
      output = screen?.screen ?? '';
    }

    const result = {
      workspace: `${workspace.project}/${workspace.name}`,
      member: member.name,
      sessionId: member.sessionId,
      interaction: interaction ? {
        id: interaction.id,
        status: interaction.status,
        // 추출 품질은 숨기지 않는다 — 어디서 온 답인지, 화면이 온전했는지.
        transcriptSource: interaction.transcriptSource ?? null,
        integrity: interaction.integrity ?? null,
      } : null,
      completed,
      screen: output,
    };
    if (asJson) return printOutput(result, true);
    if (interaction?.status === 'pending') {
      console.error(`timeout: still running after ${timeoutMs}ms — resume with id ${interaction.id}`);
    } else if (interaction?.status === 'failed') {
      console.error('agent ended the turn without answering');
    } else if (interaction && interaction.transcript === null) {
      console.error('transcript unavailable: the marked rows scrolled out of the buffer');
    }
    process.stdout.write(output);
    if (output && !output.endsWith('\n')) process.stdout.write('\n');
    return;
  }

  if (action === 'screen') {
    const workspace = await resolveWorkspace(port, args[0]);
    const member = requireMember(workspace, args[1]);
    const result = await fetchJson(port, `/api/sessions/${member.sessionId}/screen`);
    if (asJson) return printOutput({
      workspace: `${workspace.project}/${workspace.name}`,
      member: member.name,
      sessionId: member.sessionId,
      screen: result?.screen ?? '',
    }, true);
    process.stdout.write(result?.screen ?? '');
    return;
  }

  if (action === 'member' && args[0] === 'rename') {
    const workspace = await resolveWorkspace(port, args[1]);
    const member = requireMember(workspace, args[2]);
    const name = readOption(args, '--name');
    if (!name) {
      console.error('usage: ttym workspace member rename <workspace|--current> <member> --name <name>');
      process.exit(EXIT.USAGE);
    }
    const updated = await fetchPatch(port, `/api/workspaces/${encodeURIComponent(workspace.id)}/members/${member.sessionId}`, { name });
    await patchSessionMeta(port, member.sessionId, {
      project: updated.project,
      workspaceId: updated.id,
      workspaceName: updated.name,
      memberName: name,
      name,
    });
    const renamed = updated.members.find((entry) => entry.sessionId === member.sessionId);
    if (asJson) return printOutput(renamed, true);
    console.log(`${updated.project}/${updated.name}/${renamed.name}`);
    return;
  }

  console.log('usage: ttym workspace <command>');
  console.log('');
  console.log('commands:');
  console.log('  list [project] [--json]');
  console.log('  info <workspace|--current> [--json]');
  console.log('  create <project> --name <name> [--json]');
  console.log('  rename <workspace|--current> --name <name>');
  console.log('  delete <workspace|--current> [--json]');
  console.log('  add <workspace|--current> [--name <name>] [--role <role>] [--cmd ...] [--json]');
  console.log('  remove <workspace|--current> <member> [--json]');
  console.log('  detach <workspace|--current> <member> [--json]');
  console.log('  send <workspace|--current> <member> -- \"command\\\\n\"');
  console.log('  await <workspace|--current> <member> [-- \"prompt\"] [--timeout ms] [--json]');
  console.log('  screen <workspace|--current> <member> [--json]');
  console.log('  member rename <workspace|--current> <member> --name <name>');
  process.exit(EXIT.USAGE);
}

// ───── Agent Integration ─────

const AGENTS = {
  claude: {
    name: 'Claude Code',
    settingsPath: resolve(process.env.HOME || '/tmp', '.claude', 'settings.json'),
    metaKey: 'claudeSessionId',
    lastMetaKey: 'claudeLastSessionId',
    hooks: [
      {
        event: 'SessionStart',
        matcher: '',
        command: resolve(__dirname, '..', 'scripts', 'ttym-claude-hook.sh'),
      },
      // Turn start. Without it, claudeActive was set once at SessionStart and
      // cleared by the first Stop — the liveness stamp then never refreshed
      // and agent activity was invisible from the second turn on.
      {
        event: 'UserPromptSubmit',
        matcher: '',
        command: resolve(__dirname, '..', 'scripts', 'ttym-claude-activity-hook.sh'),
      },
      {
        event: 'Stop',
        matcher: '',
        command: `${resolve(__dirname, '..', 'scripts', 'ttym-claude-stop-hook.sh')} Stop`,
      },
      // A turn that ends without an answer still has to end the wait. Without
      // these, `await` on a failed or closed session blocks until its timeout.
      {
        event: 'StopFailure',
        matcher: '',
        command: `${resolve(__dirname, '..', 'scripts', 'ttym-claude-stop-hook.sh')} StopFailure`,
      },
      {
        event: 'SessionEnd',
        matcher: '',
        command: `${resolve(__dirname, '..', 'scripts', 'ttym-claude-stop-hook.sh')} SessionEnd`,
      },
    ],
    resumeArgs: (sid) => ['claude', '--resume', sid],
    resumeFlagsEnv: 'TTYM_CLAUDE_RESUME_FLAGS',
  },
  codex: {
    name: 'Codex CLI (experimental)',
    settingsPath: resolve(process.env.HOME || '/tmp', '.codex', 'hooks.json'),
    metaKey: 'codexSessionId',
    lastMetaKey: 'codexLastSessionId',
    hooks: [
      {
        event: 'SessionStart',
        matcher: '',
        command: '[ -z "$TTYM_SESSION_ID" ] && exit 0; jq -r .session_id | xargs -I{} ttym meta $TTYM_SESSION_ID --codex-session {}',
      },
      {
        event: 'Stop',
        matcher: '',
        command: resolve(__dirname, '..', 'scripts', 'ttym-codex-stop-hook.sh'),
      },
    ],
    resumeArgs: (sid) => ['codex', 'resume', sid],
    resumeFlagsEnv: 'TTYM_CODEX_RESUME_FLAGS',
  },
};

function isttymHook(command, cfg) {
  return cfg.hooks.some((hook) => command === hook.command)
    || (cfg.metaKey === 'claudeSessionId'
      && command.includes('TTYM_SESSION_ID')
      && (command.includes('--claude-session') || command.includes('--clear-claude-session')))
    || (cfg.metaKey === 'codexSessionId'
      && command.includes('TTYM_SESSION_ID')
      && (command.includes('--codex-session') || command.includes('--clear-codex-session')));
}

function isHookInstalled(cfg) {
  try {
    const settings = JSON.parse(readFileSync(cfg.settingsPath, 'utf8'));
    return cfg.hooks.every((wanted) => {
      const entries = settings?.hooks?.[wanted.event] || [];
      return entries.some((entry) => {
        const sameMatcher = (entry.matcher ?? '') === (wanted.matcher ?? '');
        return sameMatcher && entry.hooks?.some((hook) => isttymHook(hook.command || '', cfg));
      });
    });
  } catch { return false; }
}

function agentInstall(cfg) {
  let settings: Record<string, any> = {};
  try { settings = JSON.parse(readFileSync(cfg.settingsPath, 'utf8')); } catch {}

  if (!settings.hooks) settings.hooks = {};

  let changed = false;
  for (const wanted of cfg.hooks) {
    if (!Array.isArray(settings.hooks[wanted.event])) settings.hooks[wanted.event] = [];

    let target = settings.hooks[wanted.event].find((entry) => (entry.matcher ?? '') === (wanted.matcher ?? ''));
    if (!target) {
      target = { matcher: wanted.matcher, hooks: [] } as { matcher: string; hooks: unknown[] };
      settings.hooks[wanted.event].push(target);
    }
    if (!Array.isArray(target.hooks)) target.hooks = [];

    if (target.hooks.some((hook) => isttymHook(hook.command || '', cfg))) continue;
    target.hooks.push({ type: 'command', command: wanted.command, timeout: 5 });
    changed = true;
  }

  if (!changed) {
    console.log(`${cfg.name} hook already installed`);
    return;
  }

  if (existsSync(cfg.settingsPath)) {
    writeFileSync(cfg.settingsPath + '.bak', readFileSync(cfg.settingsPath));
  }
  mkdirSync(dirname(cfg.settingsPath), { recursive: true });
  writeFileSync(cfg.settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(`${cfg.name} hook installed`);
  console.log(`  file:  ${cfg.settingsPath}`);
}

function agentUninstall(cfg) {
  let settings: Record<string, any> = {};
  try { settings = JSON.parse(readFileSync(cfg.settingsPath, 'utf8')); } catch {}

  let removed = false;
  for (const wanted of cfg.hooks) {
    const entries = settings?.hooks?.[wanted.event] || [];
    for (const entry of entries) {
      if (!Array.isArray(entry.hooks)) continue;
      const before = entry.hooks.length;
      entry.hooks = entry.hooks.filter((hook) => !isttymHook(hook.command || '', cfg));
      if (entry.hooks.length < before) removed = true;
    }
  }

  if (!removed) {
    console.log(`${cfg.name} hook not found`);
    return;
  }

  if (existsSync(cfg.settingsPath)) {
    writeFileSync(cfg.settingsPath + '.bak', readFileSync(cfg.settingsPath));
  }
  writeFileSync(cfg.settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(`${cfg.name} hook uninstalled`);
}

function resolveAgent(name) {
  if (name && !AGENTS[name]) {
    console.error(`unknown agent: ${name}`);
    console.error(`available: ${Object.keys(AGENTS).join(', ')}`);
    process.exit(EXIT.USAGE);
  }
  return name ? AGENTS[name] : null;
}

async function cmdAgent() {
  const action = process.argv[3];
  // For `resume`, argv[4] may be an agent name OR a flag for the underlying agent.
  // If it starts with '-', treat it as a flag and leave agentName auto-detected.
  const argv4 = process.argv[4];
  const agentName = argv4 && !argv4.startsWith('-') ? argv4 : undefined;
  const extraArgs = action === 'resume'
    ? process.argv.slice(agentName ? 5 : 4).filter((a) => a !== '--')
    : [];

  // ── status ──
  if (action === 'status') {
    for (const [key, cfg] of Object.entries(AGENTS)) {
      const installed = isHookInstalled(cfg);
      console.log(`  ${key}: ${installed ? 'installed' : 'not installed'} (${cfg.settingsPath})`);
    }
    return;
  }

  // ── install / uninstall ──
  if (action === 'install' || action === 'uninstall') {
    if (!agentName) {
      console.error(`usage: ttym agent ${action} <${Object.keys(AGENTS).join('|')}>`);
      process.exit(EXIT.USAGE);
    }
    const cfg = resolveAgent(agentName);
    return action === 'install' ? agentInstall(cfg) : agentUninstall(cfg);
  }

  // ── info ──
  if (action === 'info') {
    const sid = agentName || process.env.TTYM_SESSION_ID;
    if (!sid || isNaN(parseInt(sid, 10))) {
      console.error('usage: ttym agent info [session-id]');
      console.error('  (or run inside a ttym session)');
      process.exit(EXIT.USAGE);
    }
    const port = getPort();
    try {
      const meta = await fetchJson(port, `/api/sessions/${parseInt(sid, 10)}/meta`);
      let found = false;
      for (const [key, cfg] of Object.entries(AGENTS)) {
        const active = meta?.[cfg.metaKey];
        const last = meta?.[cfg.lastMetaKey];
        if (active) {
          console.log(`  ${key}: ${active} (active)`);
          found = true;
        } else if (last) {
          console.log(`  ${key}: ${last} (last)`);
          found = true;
        }
      }
      if (!found) {
        console.log('no agent session linked');
        return;
      }
    } catch {
      console.error('failed to connect to ttym server');
      process.exit(EXIT.NO_SERVER);
    }
    return;
  }

  // ── resume ──
  if (action === 'resume') {
    const sid = process.env.TTYM_SESSION_ID;
    if (!sid) {
      console.error('ttym agent resume must be run inside a ttym session');
      process.exit(EXIT.FAIL);
    }
    const port = getPort();
    let meta;
    try {
      meta = await fetchJson(port, `/api/sessions/${parseInt(sid, 10)}/meta`);
    } catch {
      console.error('failed to connect to ttym server');
      process.exit(EXIT.NO_SERVER);
    }

    // Find which agent to resume
    let targetCfg = null;
    let targetSessionId = null;

    if (agentName) {
      // Explicit agent
      const cfg = resolveAgent(agentName);
      targetSessionId = meta?.[cfg.metaKey] || meta?.[cfg.lastMetaKey];
      if (!targetSessionId) {
        console.error(`no ${cfg.name} session linked to this ttym session`);
        process.exit(EXIT.NOT_FOUND);
      }
      targetCfg = cfg;
    } else {
      // Auto-detect: try active first, then last session
      for (const [, cfg] of Object.entries(AGENTS)) {
        if (meta?.[cfg.metaKey]) {
          targetCfg = cfg;
          targetSessionId = meta[cfg.metaKey];
          break;
        }
      }
      if (!targetCfg) {
        for (const [, cfg] of Object.entries(AGENTS)) {
          if (meta?.[cfg.lastMetaKey]) {
            targetCfg = cfg;
            targetSessionId = meta[cfg.lastMetaKey];
            break;
          }
        }
      }
      if (!targetCfg) {
        console.error('no agent session linked to this ttym session');
        process.exit(EXIT.NOT_FOUND);
      }
    }

    const baseArgs = targetCfg.resumeArgs(targetSessionId);
    // Default flags from env (e.g. TTYM_CLAUDE_RESUME_FLAGS="--dangerously-skip-permissions")
    const envFlags = targetCfg.resumeFlagsEnv
      ? (process.env[targetCfg.resumeFlagsEnv] || '').split(/\s+/).filter(Boolean)
      : [];
    const args = [...baseArgs, ...envFlags, ...extraArgs];
    console.log(`resuming ${targetCfg.name}: ${args.join(' ')}`);
    const child = spawn(args[0], args.slice(1), { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code ?? 0));
    return;
  }

  // ── usage ──
  console.log('usage: ttym agent <command>');
  console.log('');
  console.log('commands:');
  console.log('  install <agent>       Install SessionStart hook');
  console.log('  uninstall <agent>     Remove hook');
  console.log('  status                Show installed hooks');
  console.log('  resume [agent] [...extra-args]');
  console.log('                        Resume agent session (auto-detect or specify);');
  console.log('                        extra args are passed to the agent verbatim.');
  console.log('                        Defaults can be set via TTYM_CLAUDE_RESUME_FLAGS /');
  console.log('                        TTYM_CODEX_RESUME_FLAGS env vars.');
  console.log('  info [session-id]     Show linked agent sessions');
  console.log('');
  console.log('agents:');
  for (const [key, cfg] of Object.entries(AGENTS)) {
    console.log(`  ${key}    ${cfg.name}`);
  }
  process.exit(EXIT.USAGE);
}


// ───── Colon addresses and the top-level verbs (D2, expand phase) ─────
//
// One address grammar for the daily verbs:
//   ws:name    member "name" in workspace "ws" (workspace resolved by name,
//              or project/name when names collide across projects)
//   :name      member "name" in the current workspace ($TTYM_SESSION_ID)
//   #42        session 42 directly — the only address an unattached session
//              has, per ADR-0001
//
// These sit beside the old `workspace <verb> <ws> <member>` forms, which keep
// working untouched. Removal of the old grammar is a later, separate step.

/**
 * kitty --match 축소판: 'field:query'를 and로 조합해 멤버 집합을 고른다.
 *   필드  name role tag ws state id
 *   state idle | busy (에이전트 turn 진행 여부) | agent | shell
 * 숫자 필드(id)는 숫자로, 나머지는 부분 문자열로 비교한다.
 */
async function resolveMatches(port, expr) {
  const clauses = expr.split(/\s+and\s+/).map((clause) => {
    const at = clause.indexOf(':');
    if (at === -1) {
      console.error(`not a matcher: ${clause} (expected field:query)`);
      process.exit(EXIT.USAGE);
    }
    return { field: clause.slice(0, at).trim(), query: clause.slice(at + 1).trim() };
  });
  const needsState = clauses.some((c) => c.field === 'state');

  const workspaces = await fetchJson(port, '/api/workspaces');
  const candidates = [];
  for (const ws of workspaces) {
    for (const member of ws.members ?? []) {
      candidates.push({
        sessionId: member.sessionId,
        name: member.name ?? '',
        role: member.role ?? '',
        tags: member.tags ?? [],
        ws: `${ws.project}/${ws.name}`,
        label: `${ws.project}/${ws.name}:${member.name}`,
      });
    }
  }
  if (needsState) {
    await Promise.all(candidates.map(async (c) => {
      try {
        const runtime = await fetchJson(port, `/api/sessions/${c.sessionId}/runtime`);
        c.agentKind = runtime.agent?.kind ?? null;
        c.active = runtime.agent?.active === true;
      } catch { c.agentKind = null; c.active = false; }
    }));
  }

  const matches = candidates.filter((c) => clauses.every(({ field, query }) => {
    switch (field) {
      case 'name': return c.name.includes(query);
      case 'role': return c.role.includes(query);
      case 'tag': return c.tags.some((t) => String(t).includes(query));
      case 'ws': return c.ws.includes(query);
      case 'id': return c.sessionId === Number(query);
      case 'state':
        if (query === 'busy') return c.active === true;
        if (query === 'idle') return c.agentKind !== null && !c.active;
        if (query === 'agent') return c.agentKind !== null;
        if (query === 'shell') return !c.agentKind;
        console.error(`unknown state: ${query} (busy|idle|agent|shell)`);
        process.exit(EXIT.USAGE);
      default:
        console.error(`unknown match field: ${field} (name|role|tag|ws|state|id)`);
        process.exit(EXIT.USAGE);
    }
  }));
  if (matches.length === 0) {
    console.error(`no members match: ${expr}`);
    process.exit(EXIT.NOT_FOUND);
  }
  return matches;
}

async function resolveAddress(port, token) {
  if (!token) {
    console.error('address required: ws:name, :name, or #id');
    process.exit(EXIT.USAGE);
  }
  if (token.startsWith('#')) {
    const sessionId = parseInt(token.slice(1), 10);
    if (isNaN(sessionId)) {
      console.error(`not a session id: ${token}`);
      process.exit(EXIT.USAGE);
    }
    return { sessionId, label: `#${sessionId}`, workspace: null, member: null };
  }
  const colon = token.indexOf(':');
  if (colon === -1) {
    console.error(`not an address: ${token} (expected ws:name, :name, or #id)`);
    process.exit(EXIT.USAGE);
  }
  const wsToken = token.slice(0, colon);
  const memberToken = token.slice(colon + 1);
  const workspace = wsToken === ''
    ? await resolveCurrentWorkspace(port)
    : await resolveWorkspace(port, wsToken);
  const member = requireMember(workspace, memberToken);
  return {
    sessionId: member.sessionId,
    label: `${workspace.project}/${workspace.name}:${member.name}`,
    workspace,
    member,
  };
}

/** The workspace `ttym new` files sessions under when none is named. */
async function ensureDefaultWorkspace(port) {
  const workspaces = await listWorkspaces(port);
  const existing = workspaces.find((ws) => ws.project === 'default' && ws.name === 'default');
  if (existing) return existing;
  return await fetchPost(port, '/api/workspaces', {
    id: randomUUID().slice(0, 8),
    project: 'default',
    name: 'default',
    layout: { type: 'pane', sessionId: 0 },
    members: [],
  });
}

async function cmdNew() {
  const args = process.argv.slice(3);
  const name = args[0] && !args[0].startsWith('-') ? args[0] : null;
  if (!name) {
    console.error('usage: ttym new <name> [-- <cmd...>]');
    process.exit(EXIT.USAGE);
  }
  const port = getPort();
  await ensureCompatibleServer(port);
  const sep = args.indexOf('--');
  const cmd = sep !== -1 ? args.slice(sep + 1) : null;
  const asJson = hasFlag('--json');

  // Membership is a CLI convenience here, not a storage invariant: the session
  // gets a name by being filed in the default workspace (ADR-0001 Q1).
  const workspace = await ensureDefaultWorkspace(port);
  const { workspace: updated, member, session } = await createWorkspaceMember(port, workspace, { name, cmd });
  const result = {
    address: `${updated.project === 'default' ? '' : updated.project + '/'}${updated.name}:${member.name}`,
    sessionId: session.id,
    workspace: `${updated.project}/${updated.name}`,
  };
  if (asJson) return printOutput(result, true);
  console.log(`${result.address}  #${session.id}`);
}

async function cmdSplit() {
  const args = process.argv.slice(3);
  const targetToken = args[0];
  const name = args[1] && !args[1].startsWith('-') ? args[1] : null;
  if (!targetToken || !name) {
    console.error('usage: ttym split <ws:name|:name> <new-name> [-- <cmd...>]');
    process.exit(EXIT.USAGE);
  }
  const port = getPort();
  await ensureCompatibleServer(port);
  const sep = args.indexOf('--');
  const cmd = sep !== -1 ? args.slice(sep + 1) : null;
  const asJson = hasFlag('--json');

  const target = await resolveAddress(port, targetToken);
  if (!target.workspace) {
    console.error('split needs a workspace member as its target, not a bare session id');
    process.exit(EXIT.USAGE);
  }
  const body: Record<string, unknown> = { targetSessionId: target.sessionId, name };
  if (cmd) body.cmd = cmd;
  const data = await fetchPost(port, `/api/workspaces/${encodeURIComponent(target.workspace.id)}/split`, body);
  if (!data || data.error || !data.session) {
    console.error(`split failed: ${data?.error ?? 'no session returned'}`);
    process.exit(EXIT.FAIL);
  }
  const result = {
    address: `${target.workspace.project}/${target.workspace.name}:${name}`,
    sessionId: data.session.id,
  };
  if (asJson) return printOutput(result, true);
  console.log(`${result.address}  #${data.session.id}`);
}

async function cmdSendAddr() {
  const args = process.argv.slice(3);
  const sep = args.indexOf('--');
  const payload = sep !== -1 ? args.slice(sep + 1).join(' ') : '';
  const token = args[0];
  if (!token || !payload) {
    console.error('usage: ttym send <ws:name|:name|#id | --match "expr"> -- "data"');
    process.exit(EXIT.USAGE);
  }
  const port = getPort();
  await ensureCompatibleServer(port);
  if (token === '--match') {
    const targets = await resolveMatches(port, args[1] ?? '');
    for (const target of targets) {
      await fetchPost(port, `/api/sessions/${target.sessionId}/send`, { data: payload });
      console.log(`sent to ${target.label}`);
    }
    return;
  }
  const target = await resolveAddress(port, token);
  const result = await fetchPost(port, `/api/sessions/${target.sessionId}/send`, { data: payload });
  if (hasFlag('--json')) return printOutput(result, true);
  console.log(`sent to ${target.label}`);
}

/** 계약 조항 "비대화형 resize": ttym resize <addr> <cols> <rows> */
async function cmdResizeAddr() {
  const token = process.argv[3];
  const cols = parseInt(process.argv[4], 10);
  const rows = parseInt(process.argv[5], 10);
  if (!token || !Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) {
    console.error('usage: ttym resize <ws:name|:name|#id> <cols> <rows>');
    process.exit(EXIT.USAGE);
  }
  const port = getPort();
  const target = await resolveAddress(port, token);
  await fetchPost(port, `/api/sessions/${target.sessionId}/resize`, { cols, rows });
  if (hasFlag('--json')) return printOutput({ ok: true, sessionId: target.sessionId, cols, rows }, true);
  console.log(`resized #${target.sessionId} to ${cols}x${rows}`);
}

/** 계약 조항 "비대화형 종료": ttym kill <addr> — 세션과 holder까지 끝낸다. */
async function cmdKillAddr() {
  const token = process.argv[3];
  if (!token) {
    console.error('usage: ttym kill <ws:name|:name|#id>');
    process.exit(EXIT.USAGE);
  }
  const port = getPort();
  const target = await resolveAddress(port, token);
  await fetchDelete(port, `/api/sessions/${target.sessionId}`);
  if (hasFlag('--json')) return printOutput({ ok: true, sessionId: target.sessionId }, true);
  console.log(`killed #${target.sessionId}`);
}

async function cmdScreenAddr() {
  const args = process.argv.slice(3);
  const token = args[0];
  if (!token) {
    console.error('usage: ttym screen <ws:name|:name|#id | --match \"expr\"> [--json]');
    process.exit(EXIT.USAGE);
  }
  const port = getPort();
  await ensureCompatibleServer(port);
  if (token === '--match') {
    const targets = await resolveMatches(port, args[1] ?? '');
    const screens = [];
    for (const target of targets) {
      const result = await fetchJson(port, `/api/sessions/${target.sessionId}/screen`);
      screens.push({ target: target.label, screen: result?.screen ?? '' });
    }
    if (hasFlag('--json')) return printOutput(screens, true);
    for (const entry of screens) {
      console.log(`── ${entry.target} ──`);
      process.stdout.write(entry.screen.endsWith('\n') ? entry.screen : entry.screen + '\n');
    }
    return;
  }
  const target = await resolveAddress(port, token);
  const result = await fetchJson(port, `/api/sessions/${target.sessionId}/screen`);
  if (hasFlag('--json')) return printOutput({ target: target.label, screen: result?.screen ?? '' }, true);
  process.stdout.write(result?.screen ?? '');
}

async function cmdAwaitAddr() {
  const args = process.argv.slice(3);
  const sep = args.indexOf('--');
  const prompt = sep !== -1 ? args.slice(sep + 1).join(' ') : '';
  const token = args[0];
  if (!token || !prompt) {
    console.error('usage: ttym await <ws:name|:name|#id | --match \"expr\"> [--timeout ms] -- "prompt"');
    process.exit(EXIT.USAGE);
  }
  const port = getPort();
  await ensureCompatibleServer(port);
  const timeoutMs = parseInt(readOption(args, '--timeout') || '120000', 10);
  if (token === '--match') {
    // 매칭된 멤버 각각에 순차 await — Stop hook 완료 감지가 멤버별 독립이라
    // 병렬도 되지만, 출력이 섞이지 않게 순서대로 묻는다.
    const targets = await resolveMatches(port, args[1] ?? '');
    const results = [];
    for (const t of targets) {
      const response = await fetchRequest(port, 'POST', `/api/sessions/${t.sessionId}/interactions`, {
        prompt: prompt.replace(/[\r\n]+$/, ''),
        timeoutMs,
        submit: 'cr',
      }, timeoutMs + 15_000);
      results.push({ target: t.label, interaction: response?.interaction ?? null });
    }
    if (hasFlag('--json')) return printOutput(results, true);
    for (const entry of results) {
      console.log(`── ${entry.target} ──`);
      console.log(entry.interaction?.transcript ?? `(${entry.interaction?.status ?? 'no response'})`);
    }
    return;
  }
  const target = await resolveAddress(port, token);

  const response = await fetchRequest(port, 'POST', `/api/sessions/${target.sessionId}/interactions`, {
    prompt: prompt.replace(/[\r\n]+$/, ''),
    timeoutMs,
    submit: 'cr',
  }, timeoutMs + 15_000);
  const interaction = response?.interaction ?? null;

  let output = interaction?.transcript ?? null;
  if (output === null) {
    const screen = await fetchJson(port, `/api/sessions/${target.sessionId}/screen`).catch(() => null);
    output = screen?.screen ?? '';
  }
  if (hasFlag('--json')) {
    return printOutput({
      target: target.label,
      interaction: interaction ? {
        id: interaction.id,
        status: interaction.status,
        // 추출 품질은 숨기지 않는다 — 어디서 온 답인지, 화면이 온전했는지.
        transcriptSource: interaction.transcriptSource ?? null,
        integrity: interaction.integrity ?? null,
      } : null,
      completed: interaction?.status === 'completed',
      output,
    }, true);
  }
  if (interaction?.status === 'pending') {
    console.error(`timeout: still running after ${timeoutMs}ms — resume with id ${interaction.id}`);
  } else if (interaction?.status === 'failed') {
    console.error('agent ended the turn without answering');
  }
  process.stdout.write(output);
  if (output && !output.endsWith('\n')) process.stdout.write('\n');
}

// ───── Agent hook entry point ─────

/**
 * Report that an agent finished a turn.
 *
 * Called by the installed hook scripts, not by hand — it exists so the hook
 * does not have to rediscover the server port or the internal endpoint. The
 * event name comes straight from the agent: Claude sends Stop when it answered
 * and StopFailure / SessionEnd when it did not, and the server settles the
 * waiting interaction accordingly.
 */
async function cmdReportStop() {
  const sessionId = process.argv[4] || process.env.TTYM_SESSION_ID;
  if (!sessionId) { console.error('session id required'); process.exit(EXIT.USAGE); }
  const eventIdx = process.argv.indexOf('--event');
  const event = eventIdx > 0 ? process.argv[eventIdx + 1] : 'Stop';
  const port = getPort();
  try {
    await fetchPost(port, `/api/internal/sessions/${sessionId}/stop`, { event });
  } catch (err) {
    // A hook must never fail the agent's turn.
    if (process.env.TTYM_HOOK_DEBUG) console.error(`stop report failed: ${err.message}`);
  }
}

// ───── Main ─────

const cmd = process.argv[2];

/** fetch 실패를 계약 코드로 번역한다 — 생 스택트레이스는 계약 위반이다. */
function isConnectFailure(err) {
  if (!err) return false;
  const cause = err.cause ?? err;
  return cause?.code === 'ECONNREFUSED' || cause?.code === 'ECONNRESET'
    || cause?.code === 'UND_ERR_CONNECT_TIMEOUT' || /fetch failed/i.test(String(err?.message ?? ''));
}

try {
switch (cmd) {
  case 'attach':  await cmdAttach(); break;
  case 'new':     await cmdNew(); break;
  case 'split':   await cmdSplit(); break;
  case 'send':    await cmdSendAddr(); break;
  case 'screen':  await cmdScreenAddr(); break;
  case 'resize':  await cmdResizeAddr(); break;
  case 'kill':    await cmdKillAddr(); break;
  case 'await':   await cmdAwaitAddr(); break;
  case 'start':   cmdStart(); break;
  case 'stop':    cmdStop(); break;
  case 'restart': cmdRestart(); break;
  case 'status':  await cmdStatus(); break;
  case 'current': await cmdCurrent(); break;
  case 'project': await cmdProject(); break;
  case 'workspace': await cmdWorkspace(); break;
  case 'meta':    await cmdMeta(); break;
  case 'agent':   await cmdAgent(); break;
  case 'hook':
    // `hook report-stop` is the agent hook entry point; anything else is the
    // legacy alias for `agent`.
    if (process.argv[3] === 'report-stop') { await cmdReportStop(); break; }
    await cmdAgent();
    break;
  case 'log':     cmdLog(); break;
  default:
    console.log(`usage: ttym <command>`);
    console.log('');
    console.log('commands:');
    console.log('  start [--port 7690]          Start server in background');
    console.log('  stop                         Stop server (holders survive)');
    console.log('  restart                      Restart server');
    console.log('  attach <target> [--new]      Attach to session or workspace member (prefix: C-b, C-b ? for keys)');
  console.log('  new <name> [-- cmd]          Create a session in the default workspace');
  console.log('  split <addr> <name> [-- cmd] Split beside a member (addr: ws:name | :name)');
  console.log('  send <addr> -- "data"        Send bytes (addr: ws:name | :name | #id)');
  console.log('  screen <addr>                Read the screen');
  console.log('  resize <addr> <cols> <rows>  Resize a session');
  console.log('  kill <addr>                  Kill a session (holder included)');
  console.log('  await <addr> -- "prompt"     Ask an agent and wait for its answer');
    console.log('  status                       Show server & session info');
    console.log('  current                      Show current project/workspace/member context');
    console.log('  project list                 List projects');
    console.log('  workspace <command>          Workspace/member control plane');
    console.log('  meta <id> [--set k=v]        Session metadata (get/set)');
    console.log('  agent install <agent>        Install agent hook (claude, codex)');
    console.log('  agent uninstall <agent>      Remove agent hook');
    console.log('  agent status                 Show installed agent hooks');
    console.log('  agent resume [agent]         Resume agent session');
    console.log('  agent info [session-id]      Show linked agent sessions');
    console.log('  log [-f]                     Show server log');
    process.exit(cmd ? EXIT.USAGE : EXIT.OK); // 모르는 명령은 usage(2), 빈 호출의 help는 성공(0)
}
} catch (err) {
  if (isConnectFailure(err)) {
    console.error(`cannot reach ttym server on port ${getPort()} — is it running? (ttym start)`);
    process.exit(EXIT.NO_SERVER);
  }
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(EXIT.FAIL);
}
