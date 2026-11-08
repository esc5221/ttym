import { spawn, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
const __dirname = dirname(fileURLToPath(import.meta.url));
import { WebSocket as WsWebSocket } from 'ws';
const WebSocket = WsWebSocket;
import { readPid, GLOBAL, EXIT, getPort, apiBase, legacyBody, fetchJson, fetchPatch, fetchPost, fetchDelete, fetchRequest, ensureCompatibleServer, hasFlag, readOption, printOutput, encodeFrame, encodeDataFrame, decodeFrame, parseFrameJson, CMD, encoder, decoder, HOME_DIR, PID_FILE, LOG_FILE, SERVER_JS, HOLDER_BIN, HTTP_TIMEOUT_MS, ATTACH_RETRY_MS, DETACH_KEY } from './common.js';
import { resolveAttachTarget, listWorkspaces, memberAddress } from './addresses.js';
import { ensureServerRunning } from './lifecycle.js';
import { createInterface } from 'node:readline/promises';
import { cmdAttachDirect } from './attach-direct.js';

/** TTY에서 생성 전 확인 — 동사 오타가 워크스페이스가 되는 사고의 방어선. Enter=예. */
async function confirmCreate(what) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = (await rl.question(`${what} — create? [Y/n] `)).trim().toLowerCase();
  rl.close();
  return answer === '' || answer === 'y' || answer === 'yes';
}
// 이 파일은 C4b 분할로 main.ts에서 나왔다 — 동작 이동 없음, 구조 이동만.
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

export async function cmdAttach() {
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
  let direct = false;
  const positional = [];

  for (let i = 0; i < head.length; i += 1) {
    const arg = head[i];
    if (arg === '--json') continue;
    if (arg === '--readonly') { readonly = true; continue; }
    if (arg === '--direct') { direct = true; continue; }
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
    console.error('usage: ttym attach <session-id | workspace | workspace/member> [--new]');
    console.error('            [--readonly] [--prefix C-<key>] [--direct]');
    console.error('            [--new [--cmd <cmd...>] [--cwd <path>] [--role <role>] [--name <name>]]');
    process.exit(EXIT.USAGE);
  }
  const prefixByte = parsePrefixKey(prefixSpec);
  const pfxLabel = prefixLabel(prefixByte);
  const port = getPort();
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('ttym attach requires an interactive TTY');
    process.exit(EXIT.FAIL);
  }
  // 서버를 거치지 않는다 — 서버가 멈췄거나 꺼져 있어도 holder에 바로 (attach-direct.ts)
  if (direct) {
    await cmdAttachDirect(targetToken, { prefixByte, prefixLabel: pfxLabel, readonly });
    return;
  }
  // 진입 동사는 서버가 없으면 띄운다 — tmux의 근육. 조회 동사들은 여전히 exit 4.
  await ensureServerRunning(port);
  // TTY에서는 생성이 기본이되 확인을 거친다. --new는 확인 생략(스크립트·확신용).
  let currentTarget = await resolveAttachTarget(port, targetToken, {
    createIfMissing: true,
    confirmCreate: createNew ? null : confirmCreate,
    createOptions: { name: memberName, role, cmd: tailCmd, cwd },
  });
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
  // 전환 중인 대상이 ATTACH를 거절하면(끝난 세션) 여기로 돌아간다 — 창을 닫지 않는다.
  let switchFrom = null;

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
    switchFrom = currentTarget;
    currentTarget = nextTarget;
    lastSeq = 0;
    sendAttach();
  }

  async function collectEntries() {
    const [workspaces, sessions] = await Promise.all([
      listWorkspaces(port),
      fetchJson(port, '/api/sessions').catch(() => null),
    ]);
    // 세션 목록을 못 받았으면 gone 판정을 하지 않는다(전부 살아 있다고 본다).
    const alive = Array.isArray(sessions)
      ? new Set(sessions.filter((x) => x.status !== 'dead').map((x) => x.id))
      : null;
    const entries = [];
    for (const ws of workspaces) {
      for (const m of ws.members || []) {
        entries.push({
          sessionId: m.sessionId,
          label: memberAddress(ws, m),
          workspace: ws,
          member: m,
          gone: alive ? !alive.has(m.sessionId) : false,
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
    const header = `[ttym] session picker  (j/k ↑↓ move, Enter select, Esc/q cancel)`;
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
      let line = `${marker} ${e.label} %${e.sessionId}${current}${e.gone ? '  (gone)' : ''}`;
      if (line.length > cols) line = line.slice(0, cols - 1) + '…';
      if (selected) writeStdout(`\x1b[7m${line.padEnd(cols)}\x1b[0m\r\n`);
      else if (e.gone) writeStdout(`\x1b[2m${line}\x1b[0m\r\n`);
      else writeStdout(`${line}\r\n`);
    }
    if (picker.note) writeStdout(`\r\n\x1b[2m${picker.note.slice(0, cols)}\x1b[0m`);
  }

  function movePicker(delta) {
    if (!picker || picker.entries.length === 0) return;
    picker.note = null;
    const n = picker.entries.length;
    picker.cursor = ((picker.cursor + delta) % n + n) % n;
    renderPicker();
  }

  function exitPicker(selected) {
    const chosen = selected ? picker.entries[picker.cursor] : null;
    if (chosen?.gone) {
      // 끝난 세션으로는 못 간다 — picker에 남아서 알린다.
      picker.note = `${chosen.label} %${chosen.sessionId}: session has ended (ttym workspace remove to drop it)`;
      renderPicker();
      return;
    }
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
    const all = await collectEntries();
    const entries = all.filter((e) => !e.gone || e.sessionId === currentTarget.sessionId);
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

  /** ESC로 시작하는 시퀀스의 길이와 종류. 화살표는 CSI(ESC [ A)와 SS3(ESC O A) 둘 다 —
   *  셸·Claude가 켜 둔 애플리케이션 커서 모드(DECCKM)에서는 터미널이 SS3을 보낸다.
   *  ESC 단독만 취소다. 모르는 시퀀스는 삼킨다(예전엔 취소로 읽혀 picker가 닫혔다). */
  function readEscape(data, i) {
    if (i + 1 >= data.length) return { len: 1, key: 'esc' };
    const next = data[i + 1];
    if (next === 0x4f && i + 2 < data.length) { // SS3
      const f = data[i + 2];
      return { len: 3, key: f === 0x41 ? 'up' : f === 0x42 ? 'down' : null };
    }
    if (next === 0x5b) { // CSI: 파라미터 0x30-0x3f, 중간 0x20-0x2f, 종결 0x40-0x7e
      let j = i + 2;
      while (j < data.length && data[j] >= 0x20 && data[j] <= 0x3f) j += 1;
      if (j >= data.length) return { len: data.length - i, key: null };
      const f = data[j];
      return { len: j - i + 1, key: f === 0x41 ? 'up' : f === 0x42 ? 'down' : null };
    }
    return { len: 2, key: null }; // Alt+키
  }

  function handlePickerKey(data) {
    let i = 0;
    while (i < data.length) {
      const ready = picker && picker.entries && picker.entries.length > 0;
      const b = data[i];
      if (b === 0x1b) {
        const { len, key } = readEscape(data, i);
        if (key === 'esc') { exitPicker(false); return; }
        if (ready && key === 'up') movePicker(-1);
        else if (ready && key === 'down') movePicker(+1);
        i += len;
        continue;
      }
      if (b === 0x71 || b === 0x03) { exitPicker(false); return; }
      if (!ready) { i += 1; continue; }
      if (b === 0x0d || b === 0x0a) {
        exitPicker(true);
        if (closed || uiMode !== 'picker') return;
        i += 1;
        continue;
      }
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
          if (switchFrom) {
            // 전환 대상이 거절됨 — 원래 세션으로 돌아가고 창은 그대로 둔다.
            const failed = currentTarget;
            currentTarget = switchFrom;
            switchFrom = null;
            lastSeq = 0;
            sendAttach();
            showStatus(`${failed.label}: ${meta?.error || 'attach failed'} — back to ${currentTarget.label}`);
            return;
          }
          showStatus(meta?.error || 'attach failed');
          detached = true;
          cleanup(1);
          return;
        }
        switchFrom = null;
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
