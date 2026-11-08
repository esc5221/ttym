/**
 * ttym attach --direct — 서버를 거치지 않고 holder 소켓에 바로 붙는다.
 *
 * 왜: 메모리가 바닥나면 서버(node 스레드 하나)가 수십 초씩 멈추고, 웹·attach가 모두 그 스레드를 지나서
 * pane에 닿을 길이 없었다(2026-11-08). holder는 세션마다 따로 도는 작은 Rust 프로세스라 그때도 살아 있다.
 * 같은 맥의 Terminal에서 이 명령을 쓰면 서버 상태와 상관없이 pane을 보고 칠 수 있다.
 *
 * holder가 "viewer" 기능을 알려야 한다(STATE caps). 그 전 holder로 띄운 세션은 안 된다 — 서버가 holder를
 * 바꿔도 이미 떠 있는 holder는 옛 바이너리 그대로이기 때문.
 *
 * 화면: holder에는 터미널 에뮬레이터가 없어서 '지금 화면'을 줄 수 없다. 대신 화면을 지우고, 최근 출력
 * 일부를 다시 흘린 뒤, 프로그램에게 다시 그리라고(SIGWINCH) 한다. 크기는 바꾸지 않는다 — PTY 크기는
 * 서버가 정하고, 여기서 바꾸면 서버가 아는 화면과 어긋난다.
 */
import { connect, type Socket } from 'node:net';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { HOME_DIR, EXIT } from './common.js';

const CMD_STATE = 0x02;
const CMD_DATA_OUT = 0x03;
const CMD_DATA_IN = 0x04;
const CMD_DENIED = 0x0e;
const CMD_ACQUIRED = 0x0d;
const CMD_EXIT = 0x08;
const CMD_GAP = 0x12;
const CMD_VIEW = 0x13;
const CMD_REDRAW = 0x14;
const TAIL_BYTES = 64 * 1024;

export function runtimeDir(): string {
  return process.env.TTYM_RUNTIME_DIR || resolve(HOME_DIR, 'run');
}

/**
 * 서버에 묻지 않고 주소를 세션 id로 — 디스크의 workspaces.json만 본다.
 * `%123` · `123` · `ws:name` · `ws/name`
 */
export function resolveDirectTarget(token: string, dir = runtimeDir()): number | null {
  const bare = token.replace(/^%/, '');
  if (/^\d+$/.test(bare)) return Number(bare);
  const m = /^([^:/]+)[:/](.+)$/.exec(token);
  if (!m) return null;
  const [, wsName, member] = m;
  try {
    const data = JSON.parse(readFileSync(resolve(dir, 'workspaces.json'), 'utf8')) as { workspaces?: Array<{ id: string; name: string; members: Array<{ sessionId: number; name: string }> }> };
    const ws = (data.workspaces ?? []).find((w) => w.name === wsName || w.id === wsName);
    const hit = ws?.members.find((mm) => mm.name === member || String(mm.sessionId) === member.replace(/^%/, ''));
    return hit ? hit.sessionId : null;
  } catch {
    return null;
  }
}

export function holderSocketOf(id: number, dir = runtimeDir()): string | null {
  const manifest = resolve(dir, `session-${id}.json`);
  if (!existsSync(manifest)) return null;
  try {
    const m = JSON.parse(readFileSync(manifest, 'utf8')) as { socket?: string };
    return typeof m.socket === 'string' ? m.socket : null;
  } catch {
    return null;
  }
}

export function frame(cmd: number, payload: Uint8Array = new Uint8Array(0)): Buffer {
  const b = Buffer.alloc(5 + payload.length);
  b.writeUInt32LE(1 + payload.length, 0);
  b[4] = cmd;
  Buffer.from(payload).copy(b, 5);
  return b;
}

/** 길이 접두 프레임을 잘라 내는 리더 */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0);
  feed(chunk: Buffer): Array<{ cmd: number; payload: Buffer }> {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: Array<{ cmd: number; payload: Buffer }> = [];
    while (this.buf.length >= 5) {
      const len = this.buf.readUInt32LE(0);
      if (this.buf.length < 4 + len) break;
      out.push({ cmd: this.buf[4]!, payload: this.buf.subarray(5, 4 + len) });
      this.buf = this.buf.subarray(4 + len);
    }
    return out;
  }
}

/** holder에 viewer로 붙는다. STATE를 보고 viewer를 모르는 holder면 이유와 함께 실패. */
export function openViewer(socketPath: string, tailBytes = TAIL_BYTES): Promise<{ sock: Socket; state: Record<string, unknown>; reader: FrameReader; early: Array<{ cmd: number; payload: Buffer }> }> {
  return new Promise((resolveOpen, reject) => {
    const sock = connect(socketPath);
    const reader = new FrameReader();
    let state: Record<string, unknown> | null = null;
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('holder did not answer in 5s')); }, 5000);
    const onData = (chunk: Buffer) => {
      const frames = reader.feed(chunk);
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i]!;
        if (!state) {
          if (f.cmd !== CMD_STATE) continue;
          state = JSON.parse(f.payload.toString('utf8')) as Record<string, unknown>;
          const caps = Array.isArray(state.caps) ? state.caps as string[] : [];
          if (!caps.includes('viewer')) {
            clearTimeout(timer);
            sock.destroy();
            reject(new Error('this session runs an older holder without direct viewers — only sessions started after this update can be attached with --direct'));
            return;
          }
          const tail = Buffer.alloc(8);
          tail.writeBigUInt64LE(BigInt(tailBytes));
          sock.write(frame(CMD_VIEW, tail));
          continue;
        }
        if (f.cmd === CMD_DENIED) {
          clearTimeout(timer);
          sock.destroy();
          reject(new Error(`holder refused the viewer: ${f.payload.toString('utf8')}`));
          return;
        }
        if (f.cmd === CMD_ACQUIRED) {
          clearTimeout(timer);
          sock.off('data', onData);
          resolveOpen({ sock, state, reader, early: frames.slice(i + 1) });
          return;
        }
      }
    };
    sock.on('data', onData);
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

export async function cmdAttachDirect(token: string, opts: { prefixByte: number; prefixLabel: string; readonly: boolean }): Promise<void> {
  const id = resolveDirectTarget(token);
  if (id === null) {
    console.error(`--direct: cannot resolve ${token} without the server — use %<id> or <workspace>:<member>`);
    process.exit(EXIT.USAGE);
  }
  const socketPath = holderSocketOf(id);
  if (!socketPath) {
    console.error(`--direct: no holder manifest for session ${id} in ${runtimeDir()}`);
    process.exit(EXIT.NOT_FOUND);
  }
  let viewer;
  try {
    viewer = await openViewer(socketPath);
  } catch (e) {
    console.error(`--direct: ${(e as Error).message}`);
    process.exit(EXIT.FAIL);
  }
  const { sock, state, reader, early } = viewer;
  const cols = Number(state.cols) || 0;
  const rows = Number(state.rows) || 0;
  const out = process.stdout;
  const termCols = out.columns || 0;
  const termRows = out.rows || 0;

  // 화면 비우기 → 최근 출력 → 다시 그리기 요청
  out.write('\x1b[?1049h\x1b[H\x1b[2J');
  const handle = (f: { cmd: number; payload: Buffer }) => {
    if (f.cmd === CMD_DATA_OUT && f.payload.length >= 4) out.write(f.payload.subarray(4));
    else if (f.cmd === CMD_GAP) out.write('\r\n\x1b[90m── output skipped (fell behind) ──\x1b[0m\r\n');
    else if (f.cmd === CMD_EXIT) finish(`session ${id} exited`);
  };
  for (const f of early) handle(f);
  sock.on('data', (chunk: Buffer) => { for (const f of reader.feed(chunk)) handle(f); });
  sock.on('close', () => finish('holder closed the connection'));
  sock.on('error', () => finish('holder connection error'));
  setTimeout(() => sock.write(frame(CMD_REDRAW)), 50);

  let done = false;
  function finish(reason: string) {
    if (done) return;
    done = true;
    try { process.stdin.setRawMode(false); } catch {}
    out.write('\x1b[?1049l');
    console.error(`[ttym] ${reason}`);
    sock.destroy();
    process.exit(0);
  }

  console.error(`[ttym] direct to session ${id} (holder, no server) — ${opts.prefixLabel} d detaches` +
    (cols && rows && (cols !== termCols || rows !== termRows) ? ` · pane is ${cols}x${rows}, this terminal ${termCols}x${termRows}` : ''));

  process.stdin.setRawMode(true);
  process.stdin.resume();
  let prefixed = false;
  process.stdin.on('data', (chunk: Buffer) => {
    const pass: number[] = [];
    for (const b of chunk) {
      if (prefixed) {
        prefixed = false;
        if (b === 0x64 /* d */) { finish('detached'); return; }
        if (b === opts.prefixByte) { pass.push(b); continue; }
        continue; // 다른 prefix 명령은 direct에서 안 쓴다
      }
      if (b === opts.prefixByte) { prefixed = true; continue; }
      pass.push(b);
    }
    if (pass.length && !opts.readonly) sock.write(frame(CMD_DATA_IN, Uint8Array.from(pass)));
  });
}
