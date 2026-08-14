import { spawn, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { WebSocket as WsWebSocket } from 'ws';
import { request as apiRequest, ApiError } from '@ttym/api';
import { API_VERSION, isRuntimeMetaKey } from '@ttym/protocol';

export const __dirname = dirname(fileURLToPath(import.meta.url));
export const WebSocket = WsWebSocket;
// `env TTYM_HOME=~/x`처럼 셸이 틸드를 안 편 채 도달하는 경우가 실재한다 —
// 그대로 resolve하면 cwd 아래 '~' 디렉터리라는 유령 경로가 된다. 여기서 편다.
const rawHome = process.env.TTYM_HOME?.replace(/^~(?=$|\/)/, process.env.HOME || '');
export const HOME_DIR = rawHome
  ? resolve(rawHome)
  : resolve(process.env.HOME || '/tmp', '.ttym');
export const PID_FILE = resolve(HOME_DIR, 'ttym.pid');
export const LOG_FILE = resolve(HOME_DIR, 'ttym.log');
export const SERVER_JS = resolve(__dirname, 'ttym-server.js');
export const HOLDER_BIN = resolve(__dirname, 'ttym-holder');
export const HTTP_TIMEOUT_MS = parseInt(process.env.TTYM_HTTP_TIMEOUT_MS || '5000', 10);
export const ATTACH_RETRY_MS = parseInt(process.env.TTYM_ATTACH_RETRY_MS || '1000', 10);
export const DETACH_KEY = '\u001d';

export const CMD = {
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
export const encoder = new TextEncoder();
export const decoder = new TextDecoder();

// ───── Helpers ─────

export function readPid() {
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
export const GLOBAL = { port: null, json: false };
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
export const EXIT = { OK: 0, FAIL: 1, USAGE: 2, NOT_FOUND: 3, NO_SERVER: 4, VERSION: 5 };

export function getPort() {
  if (GLOBAL.port !== null) return GLOBAL.port;
  return parseInt(process.env.PORT || '7690', 10);
}

export const apiBase = (port) => `http://127.0.0.1:${port}`;

/** The old helpers resolved the parsed body no matter the status; keep that. */
export function legacyBody(err) {
  if (err instanceof ApiError) {
    try { return JSON.parse(err.body); } catch { return null; }
  }
  throw err;
}

export async function fetchJson(port, path) {
  try {
    return await apiRequest(apiBase(port), path, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch (err) { return legacyBody(err); }
}

export function fetchPatch(port, path, body) {
  return fetchRequest(port, 'PATCH', path, body);
}

export function fetchPost(port, path, body) {
  return fetchRequest(port, 'POST', path, body);
}

export function fetchDelete(port, path) {
  return fetchRequest(port, 'DELETE', path);
}

export async function fetchRequest(port, method, path, body = undefined, timeoutMs = HTTP_TIMEOUT_MS) {
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
export let versionChecked = false;
export async function ensureCompatibleServer(port) {
  if (versionChecked) return;
  versionChecked = true;
  let info = null;
  try {
    info = await apiRequest(apiBase(port), '/api/version', { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch (err) {
    if (err instanceof ApiError) {
      // /api/version이 없다면 그건 ttym 서버가 아니거나 화석이다 — 호환 불가.
      console.error('error: no version endpoint — not a ttym server this CLI can talk to');
      process.exit(EXIT.VERSION);
    }
    return; // unreachable server: let the command fail with its own message
  }
  if (info && typeof info.apiVersion === 'number') {
    // 정확일치가 아니라 범위: 서버는 [minApiVersion, apiVersion]을 이해한다.
    // 비파괴 업그레이드(min 유지, api만 상승)에 구 CLI가 죽지 않게.
    const min = typeof info.minApiVersion === 'number' ? info.minApiVersion : info.apiVersion;
    if (API_VERSION < min || API_VERSION > info.apiVersion) {
      console.error(`error: server speaks api v${min}..v${info.apiVersion}, this CLI speaks v${API_VERSION}`);
      console.error('       restart the server from the same build as this CLI');
      process.exit(EXIT.VERSION);
    }
  }
}

/**
 * 쉘 통합 세션이면 명령을 서버 blocking 엔드포인트로 실행하고 결과를 반환.
 * 통합 신호가 없는 세션이면 null — 호출부가 에이전트(interaction) 경로로 간다.
 */
export async function shellAwait(port, sessionId, command, timeoutMs) {
  const probe = await fetchJson(port, `/api/sessions/${sessionId}/commands?limit=1`).catch(() => null);
  if (!probe || probe.integration !== true) return null;
  return fetchRequest(port, 'POST', `/api/sessions/${sessionId}/commands`, { command, timeoutMs }, timeoutMs + 15_000);
}

/** CSI·OSC·제어문자 제거 — 개행·탭은 살린다. 명령 출력의 사람용 기본 표시. */
export function stripAnsi(text) {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[0-9A-Za-z]/g, '')
    .replace(/\x1b[()][0-9A-Za-z]/g, '')
    .replace(/\r/g, '')
    .replace(/[\x00-\x08\x0b-\x1f]/g, '');
}

/**
 * 명령 출력의 사람용 정리 — ANSI 제거 + zsh partial-line 마크 잔재 절단.
 * zsh는 매 프롬프트 전에 '%'+패딩+CR+지우개(ESC[K])를 찍는데, 스트립이
 * 지우개만 없애면 '%'와 패딩이 꼬리에 남는다. 줄머리의 '%'만 자르므로
 * "100%" 같은 실데이터는 건드리지 않는다.
 */
export function cleanShellOutput(text) {
  return stripAnsi(text).replace(/(?:\n|^)%[ ]*$/, '').replace(/\s+$/, '');
}

export function hasFlag(flag) {
  if (flag === '--json') return GLOBAL.json;
  return process.argv.includes(flag);
}

export function readOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  return args[index + 1] ?? null;
}

export function printOutput(value, asJson = false) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  console.log(value);
}

export function encodeFrame(sessionId, cmd, payload: Uint8Array = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const frame = Buffer.allocUnsafe(3 + body.length);
  frame.writeUInt16LE(sessionId, 0);
  frame[2] = cmd;
  if (body.length > 0) body.copy(frame, 3);
  return frame;
}

export function encodeDataFrame(sessionId, seq, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const frame = Buffer.allocUnsafe(7 + body.length);
  frame.writeUInt16LE(sessionId, 0);
  frame[2] = CMD.DATA;
  frame.writeUInt32LE(seq, 3);
  body.copy(frame, 7);
  return frame;
}

export function decodeFrame(raw) {
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

export function parseFrameJson(payload) {
  try {
    return JSON.parse(decoder.decode(payload));
  } catch {
    return null;
  }
}
