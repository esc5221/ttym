import { spawn, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
const __dirname = dirname(fileURLToPath(import.meta.url));
import wsPkg from 'ws';
const { WebSocket } = wsPkg;
import { readPid, GLOBAL, EXIT, getPort, apiBase, legacyBody, fetchJson, fetchPatch, fetchPost, fetchDelete, fetchRequest, ensureCompatibleServer, hasFlag, readOption, printOutput, encodeFrame, encodeDataFrame, decodeFrame, parseFrameJson, CMD, encoder, decoder, HOME_DIR, PID_FILE, LOG_FILE, SERVER_JS, HOLDER_BIN, HTTP_TIMEOUT_MS, ATTACH_RETRY_MS, DETACH_KEY } from './common.js';
import { resolveAttachTarget, listWorkspaces, memberAddress } from './addresses.js';
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
