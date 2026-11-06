import { spawn, ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createConnection, Socket } from 'node:net';
import { existsSync, openSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire as nodeCreateRequire } from 'node:module';
import headless from '@xterm/headless';
const { Terminal } = headless;
import { SerializeAddon } from '@xterm/addon-serialize';
import type { ScreenRun } from '@ttym/protocol';
import { screenTail, tailCursor } from './screen-tail.js';
import { OutputRing } from './output-ring.js';
import { SyncBlockFilter } from './sync-block.js';
import { CommandIndex } from './command-index.js';

export type SessionStatus = 'attached' | 'detached' | 'dead';
export type ViewerMode = 'readwrite' | 'readonly';

/** An xterm marker: `line` tracks its row, and goes to -1 once it scrolls out. */
export interface TerminalMarker {
  readonly line: number;
  dispose(): void;
}

export interface SessionInfo {
  id: number;
  pid: number;
  cmd: string[];
  cols: number;
  rows: number;
  status: SessionStatus;
  viewerCount: number;
  lastSeq: number;
  createdAt: number;
  detachedAt: number | null;
}

export type DataCb = (data: Buffer, seq: number) => void;
type ExitCb = (code: number) => void;

export interface Viewer {
  dataCb: DataCb;
  mode: ViewerMode;
  paused: boolean;
}

// ───── Holder protocol ─────

// 새로고침 뒤 얼마나 거슬러 올라갈 수 있는지를 정하는 값이다.
// 에이전트 TUI는 같은 행을 반복해 다시 그리므로 raw 바이트가 크다 — 실측으로
// Claude 응답이 행당 913바이트, Codex 1,111바이트, zsh은 79바이트다.
// 1MB면 zsh은 1만 3천 줄이지만 Claude는 1,150줄밖에 안 된다. 4MB로 잡으면
// Claude 기준 약 4,600줄이고, 세션 41개에서 164MB다.
const DEFAULT_RING_BYTES = 4 * 1024 * 1024;
/** xterm 쓰기 대기열이 이만큼 쌓이면 holder 소켓을 멈추고, LOW 아래로 내려오면 다시 읽는다. */
const PARSE_HIGH_WATER = 8 * 1024 * 1024;
const PARSE_LOW_WATER = 2 * 1024 * 1024;

function randomSeqBase(): number {
  return 1_000_000 + Math.floor(Math.random() * 99_000_000);
}

function ringBytes(): number {
  const raw = Number(process.env.TTYM_RING_BYTES);
  if (Number.isFinite(raw) && raw >= 64 * 1024) return Math.trunc(raw);
  return DEFAULT_RING_BYTES;
}

const H_CMD_STATE = 0x02;
const H_CMD_DATA_OUT = 0x03;
const H_CMD_DATA_IN = 0x04;
const H_CMD_RESIZE = 0x05;
const H_CMD_DUMP_REQ = 0x06;
const H_CMD_DUMP_RESP = 0x07;
const H_CMD_EXIT = 0x08;
const H_CMD_KILL = 0x09;
const H_CMD_PING = 0x0a;
const H_CMD_PONG = 0x0b;
// Controller lease. Only sent when the holder advertises `lease` in STATE, so
// an older holder never sees a frame it does not understand.
const H_CMD_ACQUIRE = 0x0c;
const H_CMD_ACQUIRED = 0x0d;
const H_CMD_DENIED = 0x0e;
const H_CMD_EVICTED = 0x0f;
const H_CMD_DUMP_SINCE = 0x10;
/** holder journal이 컨트롤러 뒤처짐을 다 담지 못해 [from, to)를 건너뛰었다. payload [u64 from][u64 to] */
const H_CMD_GAP = 0x12;
const H_CMD_REPLAY = 0x11;

/** Identifies this server process to holders, so an eviction is attributable. */
const SERVER_INSTANCE_ID = `srv-${process.pid}-${Date.now().toString(36)}`;

/** Raised when another server already holds the PTY and takeover was not asked for. */
/** holder가 handshake에 답하지 않았다. holder는 살아 있을 수 있다 — 세션을 버릴 근거가 아니다. */
/** CUP to the stored cursor. serialize() can leave the cursor one cell short after trailing blanks. */
function cursorTo(pos: { x: number; y: number } | null | undefined): string {
  return pos ? `\x1b[${pos.y + 1};${pos.x + 1}H` : '';
}

export class HolderHandshakeTimeout extends Error {
  constructor(readonly sessionId: number) { super('holder handshake timeout'); }
}

const RECOVER_HANDSHAKE_MS = 30_000;

export class ControllerHeldError extends Error {
  constructor(readonly sessionId: number) {
    super(`session ${sessionId}: controller already held by another server`);
    this.name = 'ControllerHeldError';
  }
}
const ENABLE_SYNC_BLOCK_COALESCING = process.env.TTYM_SYNC_BLOCK_COALESCING !== '0';

function getSyncBlockTimeoutMs(): number {
  return Number.parseInt(process.env.TTYM_SYNC_BLOCK_TIMEOUT_MS ?? '1000', 10) || 1000;
}

/**
 * Per-block sync tracing is opt-in. A full-screen TUI opens a sync block per
 * frame, so one busy pane wrote 260,000 lines by itself and the server's
 * stdout log reached 716MB — 93.6% of its last 60MB was sync start/end.
 * The counters below survive without the lines: the heartbeat prints one
 * aggregate, and anomalies (overflow, timeout, reset) still log unconditionally.
 */
const VERBOSE = process.env.TTYM_DEBUG === '1';

const syncTotals = {
  blocks: 0, overflow: 0, timeout: 0, resets: 0,
  rawBytes: 0, emittedBytes: 0,
  sessions: new Set<number>(),
};

export interface SyncStats {
  blocks: number; overflow: number; timeout: number; resets: number;
  rawBytes: number; emittedBytes: number; sessions: number;
}

/** Read the counters accumulated since the last call and reset them. */
export function drainSyncStats(): SyncStats {
  const out: SyncStats = {
    blocks: syncTotals.blocks, overflow: syncTotals.overflow,
    timeout: syncTotals.timeout, resets: syncTotals.resets,
    rawBytes: syncTotals.rawBytes, emittedBytes: syncTotals.emittedBytes,
    sessions: syncTotals.sessions.size,
  };
  syncTotals.blocks = 0; syncTotals.overflow = 0;
  syncTotals.timeout = 0; syncTotals.resets = 0;
  syncTotals.rawBytes = 0; syncTotals.emittedBytes = 0;
  syncTotals.sessions.clear();
  return out;
}

/**
 * Runtime markers a parent agent stamps on its own child processes. A ttym
 * server started from inside a Claude Code Bash tool inherits them, survives
 * as a daemon, and hands the fossilized set to every session it ever spawns.
 * Three observed casualties from one leak: CLAUDE_CODE_CHILD_SESSION turned
 * transcript saving off for a claude running in a pane; CLAUDE_JOB_DIR made
 * that claude write its /rename into another session's transcript; and the
 * stale identity chain confused hooks. The first five are the exact set
 * Claude Code scrubs for its own detached spawns; the rest are leaks we
 * measured on a live holder. TTYM_* is deliberately not scrubbed — that is
 * our own contract, re-stamped per session below.
 */
// Agent-runtime env is scrubbed by prefix, not by list. The list version went
// stale within one harness release: CLAUDE_EFFORT, CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
// and CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY appeared and slipped straight into
// sessions — a claude launched in a pane silently ran with someone else's
// effort and autocompact settings. Job-injected names churn every release;
// user-intent names are rare and stable, so those are the exceptions.
const PARENT_AGENT_MARKERS = ['AI_AGENT', 'TRACEPARENT'];
const AGENT_ENV_PREFIX = 'CLAUDE';
const AGENT_ENV_KEEP = new Set([
  'CLAUDE_CONFIG_DIR', // points claude at an alternate config dir — user intent
  'CLAUDE_CODE_FORCE_SESSION_PERSISTENCE', // explicit opt-in, never fossil
]);

export function buildSessionEnv(extraEnv?: Record<string, string>): Record<string, string> {
  const env = { ...process.env, ...(extraEnv ?? {}) } as Record<string, string>;
  for (const key of PARENT_AGENT_MARKERS) delete env[key];
  for (const key of Object.keys(env)) {
    if (key.startsWith(AGENT_ENV_PREFIX) && !AGENT_ENV_KEEP.has(key)) delete env[key];
  }
  // ttym sessions should behave like real terminals, not inherit global no-color mode.
  delete env.NO_COLOR;
  // Codex parent sessions can export GIT_PAGER=cat, which disables interactive
  // pagers like `git log` inside ttym PTYs. Drop only that degenerate case.
  if (env.GIT_PAGER === 'cat') delete env.GIT_PAGER;
  if (!env.CLICOLOR) env.CLICOLOR = '1';
  if (!env.CLICOLOR_FORCE) env.CLICOLOR_FORCE = '1';
  if (!env.FORCE_COLOR) env.FORCE_COLOR = '1';
  if (!env.COLORTERM) env.COLORTERM = 'truecolor';
  return env;
}

function writeFrame(sock: Socket, cmd: number, payload: Buffer = Buffer.alloc(0)) {
  const hdr = Buffer.allocUnsafe(5);
  hdr.writeUInt32LE(1 + payload.length, 0);
  hdr[4] = cmd;
  sock.write(hdr);
  if (payload.length > 0) sock.write(payload);
}

/** Parse length-prefixed frames from a stream */
class HolderFrameReader {
  private buf = Buffer.alloc(0);

  feed(data: Buffer | Uint8Array) {
    const buf = Buffer.from(data);
    this.buf = this.buf.length === 0 ? buf : Buffer.concat([this.buf, buf]);
  }

  *frames(): Generator<{ cmd: number; payload: Buffer }> {
    while (this.buf.length >= 5) {
      const flen = this.buf.readUInt32LE(0);
      if (flen === 0 || this.buf.length < 4 + flen) break;
      const cmd = this.buf[4];
      const payload = this.buf.subarray(5, 4 + flen);
      this.buf = this.buf.subarray(4 + flen);
      yield { cmd, payload };
    }
  }
}

// ───── Runtime dir ─────

export function getHomeDir(): string {
  // TTYM_HOME lets a dev server keep its pid file, logs, and runtime dir out of
  // the production ~/.ttym — otherwise both write the same ttym.pid and the dev
  // server unlinks it on shutdown.
  if (process.env.TTYM_HOME) return resolve(process.env.TTYM_HOME);
  return resolve(process.env.HOME || '/tmp', '.ttym');
}

/**
 * FNV-1a 64 over the runtime-dir string as passed to the holder. The Rust twin
 * lives in holder/src/main.rs (fnv1a64) — the two must agree byte for byte,
 * which is why neither side canonicalizes: Rust's canonicalize resolves
 * symlinks (/var → /private/var) and Node's resolve() does not.
 */
function fnv1a64(input: string): bigint {
  const MASK = 0xffffffffffffffffn;
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(input, 'utf8')) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & MASK;
  }
  return hash;
}

/**
 * Where a session's holder socket lives: a short, deterministic namespace
 * (/tmp/ttym-<uid>/<hash>/) instead of the runtime dir, because sockaddr_un
 * caps paths at ~104 bytes and a deep TTYM_RUNTIME_DIR used to panic the
 * holder's bind (and would break our own connect the same way). Recovery
 * still connects to whatever the manifest recorded, so old sessions keep
 * their old paths.
 */
export function holderSocketPath(runtimeDir: string, id: number, nonce: string): string {
  const uid = process.getuid?.() ?? 0;
  const hash = fnv1a64(runtimeDir).toString(16).padStart(16, '0');
  // The nonce makes the path unique per holder INCARNATION. Without it, a
  // stale socket left by a dead session whose id got recycled (runtime dir
  // wiped, ids restart) still has a live listener behind it — and a fresh
  // server's connect lands on the wrong holder. Measured, not hypothetical.
  const path = `/tmp/ttym-${uid}/${hash}/session-${id}-${nonce}.sock`;
  if (Buffer.byteLength(path) > 100) {
    throw new Error(`holder socket path exceeds sockaddr_un limit: ${path}`);
  }
  return path;
}

export function getRuntimeDir(): string {
  const env = process.env;
  if (env.TTYM_RUNTIME_DIR) return env.TTYM_RUNTIME_DIR;
  return resolve(getHomeDir(), 'run');
}

// ───── Holder binary path ─────

function holderBin(): string {
  if (process.env.TTYM_HOLDER_BIN) return process.env.TTYM_HOLDER_BIN;
  // 1. Same directory as this script (bundled dist/, source checkout)
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const samedir = resolve(__dirname, 'ttym-holder');
  if (existsSync(samedir)) return samedir;
  // 2. npm install: the platform package (esbuild pattern — optionalDependencies,
  //    never a postinstall download)
  try {
    const req = nodeCreateRequire(import.meta.url);
    return req.resolve(`@ttym/holder-${process.platform}-${process.arch}/ttym-holder`);
  } catch {}
  // 3. Dev: relative to packages/server/src/
  return resolve(__dirname, '../../../holder/target/release/ttym-holder');
}

// ───── Session ─────

/**
 * 3-layer session with external holder process for PTY persistence.
 *
 * Holder: Rust binary that owns PTY FD + ring buffer (survives server restart)
 * Server: headless xterm (snapshot) + OutputRing (viewer delta) + viewers
 */
export class Session {
  readonly id: number;
  readonly pid: number; // holder process pid
  readonly childPid: number; // actual shell pid
  readonly cmd: string[];
  readonly createdAt: number;

  // Holder connection
  private sock: Socket | null = null;
  private holderProc: ChildProcess | null = null;
  private reader = new HolderFrameReader();
  private closed = false;

  // Layer 2: Headless terminal state (server-side mirror)
  private term!: InstanceType<typeof Terminal>;
  private serializer!: SerializeAddon;

  // Layer 3: Ring buffer (for viewer delta replay)
  readonly ring: OutputRing;
  readonly commands: CommandIndex;

  // Multi-viewer state
  private viewers = new Map<string, Viewer>();
  private _detachedAt: number | null = null;
  private exitCbs: ExitCb[] = [];
  private _cols: number;
  private _rows: number;
  private _dirty = false;
  /** 화면이 바뀔 때마다 오른다. 체크포인트는 찍은 rev와 같을 때만 clean으로 내린다. */
  private _rev = 0;
  private _lastDirtyAt = 0;
  private _diedAt = 0;
  private _evicted = false;
  private _generation = '';
  private _appliedOffset = 0;
  /** holder에서 받은 바이트 위치(파싱 전). appliedOffset과의 차이가 xterm 대기열이다. */
  private _receivedOffset = 0;
  private parsePendingBytes = 0;
  private parsePaused = false;
  private droppedParseBytes = 0;
  /** holder가 STATE로 알린 기능. 'journal' = 커서 스트리밍(느린 서버가 PTY를 멈추지 않음). */
  holderCaps: string[] = [];
  private _recoveryGap = false;
  /**
   * Screen quality. 'degraded' after a gap recovery: the tail the holder
   * served is lexically safe (new holders) but the middle is missing, so the
   * rendered screen is not a faithful continuation. Only a full repaint the
   * stream itself performs (RIS) earns 'healthy' back — a checkpoint write
   * cannot, because checkpointing a degraded screen just launders it into
   * the next recovery's trusted base.
   */
  private _integrity: 'healthy' | 'degraded' = 'healthy';
  private _exitCode: number | null = null;
  private supportsReplay = false;
  private readonly syncFilter = new SyncBlockFilter();
  private syncBlocksStarted = 0;
  private syncBlocksCompleted = 0;
  private syncOverflowCount = 0;
  private syncBufferedBytes = 0;
  private syncEmittedBytes = 0;
  private syncTimeoutCount = 0;
  private syncTimer: NodeJS.Timeout | null = null;

  private debug(message: string): void {
    console.log(`[sess ${this.id}] ${message}`);
  }

  /** Per-frame diagnostics. Silent unless TTYM_DEBUG=1 — see VERBOSE above. */
  private trace(message: string): void {
    if (VERBOSE) this.debug(message);
  }

  get dirty(): boolean { return this._dirty; }
  get rev(): number { return this._rev; }
  get lastDirtyAt(): number { return this._lastDirtyAt; }
  get diedAt(): number { return this._diedAt; }
  /** True when this server lost the lease rather than the PTY exiting. */
  get evicted(): boolean { return this._evicted; }
  /** Holder incarnation this session is attached to. */
  get generation(): string { return this._generation; }
  /** Stream offset the terminal has been advanced through. */
  get appliedOffset(): number { return this._appliedOffset; }
  /** True when recovery could not reach back to the checkpoint. */
  get recoveryGap(): boolean { return this._recoveryGap; }
  get integrity(): 'healthy' | 'degraded' { return this._integrity; }
  /** Exit code once the PTY has died; -1 unknown, -2 lease lost. */
  get exitCode(): number | null { return this._exitCode; }

  /**
   * Seed the terminal from a saved checkpoint before any delta is applied.
   * Returns false when the checkpoint belongs to a different holder incarnation.
   */
  seedCheckpoint(generation: string, offset: number, screen: string, cursor?: { x: number; y: number }): boolean {
    if (generation && this._generation && generation !== this._generation) return false;
    this.resetSyncEmissionState('seed checkpoint');
    this.term.write(screen + cursorTo(cursor));
    this._appliedOffset = offset;
    return true;
  }

  /** Per-row soft-wrap flags, so a resize can reflow what was restored. */
  wrapFlags(): string {
    if (this.cold) return this.cold.wrap;
    const buf = this.term.buffer.active;
    const bits: number[] = [];
    for (let i = 0; i < buf.length; i++) {
      const byte = i >> 3;
      if (bits[byte] === undefined) bits[byte] = 0;
      if (buf.getLine(i)?.isWrapped) bits[byte] |= 1 << (i & 7);
    }
    return Buffer.from(bits.map((b) => b ?? 0)).toString('base64');
  }
  markClean(): void { this._dirty = false; }
  /** 저장하는 동안 새 출력이 들어왔으면 dirty를 남긴다. */
  markCleanIf(rev: number): void { if (this._rev === rev) this._dirty = false; }

  private constructor(
    id: number, cmd: string[], cols: number, rows: number,
    pid: number, childPid: number, createdAt: number,
  ) {
    this.id = id;
    this.cmd = cmd;
    this.pid = pid;
    this.childPid = childPid;
    this.createdAt = createdAt;
    this._cols = cols;
    this._rows = rows;

    // Layer 2 (created below, after the command index it feeds)

    // Layer 3. Sized so a tab hidden through a normal burst of agent output
    // still resyncs by delta replay instead of a snapshot; the sync filter can
    // emit a single 512KB block, which the old 128KB ring could not even hold.
    // The sequence base is random per boot: seqs restart on recovery, and a
    // client watermark from a previous boot that happens to land inside this
    // boot's numeric range would replay someone else's delta onto the wrong
    // screen. A random base makes cross-boot collision practically impossible
    // — stale watermarks fall outside [base, lastSeq] and take the snapshot
    // path. Base stays far under u32 wire range (seq is u32 on the wire).
    this.ring = new OutputRing(ringBytes(), randomSeqBase());

    // 명령 인덱스 — 쉘의 OSC 133/633 신호를 스트림 좌표(ring seq)와 함께 기록.
    // 핸들러는 term.write 파싱 중에 불리고 ring push는 그 뒤라, nextSeq가
    // 곧 이 청크의 시작 좌표다. true 반환은 headless 소비만 뜻한다 —
    // 클라이언트 전달은 ring 원본 바이트로 이미 이뤄진다.
    this.commands = new CommandIndex(() => this.ring.nextSeq);
    this.createTerm(cols, rows);
  }

  private createTerm(cols: number, rows: number): void {
    this.term = new Terminal({ cols, rows, scrollback: 3000, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer as any);
    this.term.parser.registerOscHandler(133, (data) => { this.commands.osc133(data); return true; });
    this.term.parser.registerOscHandler(633, (data) => { this.commands.osc633(data); return true; });
  }

  // ── Cold: no live terminal for a session nobody is using ─────────────────
  //
  // A headless terminal costs ~3MB per session (measured on 100 prod checkpoints) and, when the
  // machine is under memory pressure, the OS compresses it; any later touch (a sweep, a GC) then
  // stalls the whole event loop while pages come back. A session with no viewer, no output and no
  // input for COLD_AFTER_MS keeps only what callers read synchronously — the full and viewer
  // snapshots (deflated, ~20KB), the plain screen, the styled tail — and drops the terminal.
  // Output arriving for it is held in order and replayed onto a terminal rebuilt from the snapshot;
  // with the holder journal (S1) nothing is lost while it is cold. Same path a server restart uses
  // (checkpoint + bytes after it), now without a restart.

  private cold: {
    full: Buffer; viewer: Buffer; text: string; tail: ScreenRun[][];
    cursor: { x: number; y: number } | null; wrap: string;
    cols: number; rows: number; backlog: Buffer[]; backlogBytes: number;
    pos: { x: number; y: number } | null;
  } | null = null;
  private warming: Promise<void> | null = null;
  private pendingMarkers: Array<{ real: TerminalMarker | null }> = [];
  private lastMarkAt = 0;

  get isCold(): boolean { return this.cold !== null; }

  /** Nothing about the session's state forbids dropping its terminal (time aside). */
  private coldAllowed(): boolean {
    if (this.cold || this.closed || this.warming) return false;
    // 뷰어가 있으면 살아 있는 화면이 필요하다. 잠든 pane(frozen)은 뷰어에게도 얼린 화면만 준다 — 내려도 된다.
    if (this.viewers.size > 0 && !this.frozen) return false;
    if (this.parsePendingBytes > 0 || this.syncFilter.syncOpen) return false;
    if (this.term.buffer.active.type === 'alternate') return false; // vim·less: modes and regions a snapshot does not carry
    return true;
  }

  /** True when this session may drop its terminal now (see SessionManager.coolIdle). */
  canGoCold(now: number, idleMs: number): boolean {
    if (!this.coldAllowed()) return false;
    if (now - this.lastOutputAt < idleMs || now - this.lastInputAt < idleMs) return false;
    if (now - this.lastMarkAt < 30 * 60_000) return false;       // an await may still read its screen range
    return true;
  }

  /** Drop the terminal, keeping deflated snapshots and the cached screen. Returns false if not allowed. */
  goCold(): boolean {
    if (!this.coldAllowed()) return false;
    const full = this.serializer.serialize();
    const viewer = this.serializer.serialize({ scrollback: 1000 });
    this.cold = {
      full: deflateSync(full), viewer: deflateSync(viewer),
      text: this.screenText(), tail: screenTail(this.term, this._rows), cursor: tailCursor(this.term, this._rows),
      wrap: this.wrapFlags(), cols: this._cols, rows: this._rows, backlog: [], backlogBytes: 0,
      pos: this.cursorPos(),
    };
    this.term.dispose();
    this.term = null as unknown as InstanceType<typeof Terminal>;
    this.serializer = null as unknown as SerializeAddon;
    this.debug(`cold: snapshot ${full.length}B → ${this.cold.full.length}B deflated`);
    return true;
  }

  /** Rebuild the terminal from the cold snapshot, then replay output that arrived meanwhile. */
  ensureWarm(): Promise<void> {
    if (!this.cold) return Promise.resolve();
    if (this.warming) return this.warming;
    const c = this.cold;
    this.warming = new Promise<void>((done) => {
      this.createTerm(c.cols, c.rows);
      this.resetSyncEmissionState('warm');
      this.term.write(inflateSync(c.full).toString() + cursorTo(c.pos), () => {
        if (this.closed) { this.warming = null; done(); return; }
        if (this._cols !== c.cols || this._rows !== c.rows) { try { this.term.resize(this._cols, this._rows); } catch {} }
        for (const m of this.pendingMarkers) m.real = this.term.registerMarker(0) ?? null;
        this.pendingMarkers = [];
        this.cold = null;
        this.warming = null;
        const backlog = c.backlog;
        this.debug(`warm: replaying ${c.backlogBytes}B held while cold`);
        for (const chunk of backlog) this.queueParse(chunk);
        done();
      });
    });
    return this.warming;
  }

  /** Create a new session: spawn holder, connect */
  static async create(
    id: number, cmd: string[], cols: number, rows: number,
    runtimeDir: string, cwd?: string, extraEnv?: Record<string, string>,
  ): Promise<Session> {
    const socketPath = holderSocketPath(runtimeDir, id, randomUUID().slice(0, 8));

    // Spawn holder (detached, survives server exit)
    // stdio must be 'ignore' — pipe would kill holder on SIGPIPE when server exits
    const args = [
      '--id', String(id),
      '--cols', String(cols),
      '--rows', String(rows),
      '--runtime-dir', runtimeDir,
      '--socket', socketPath,
    ];
    if (cwd) args.push('--cwd', cwd);
    args.push('--', ...cmd);

    // A missing holder used to surface as an unhandled spawn 'error' event,
    // which took the whole server down with every other session's viewer.
    const bin = holderBin();
    if (!existsSync(bin)) throw new Error(`ttym-holder not found at ${bin} — reinstall ttym, or point TTYM_HOLDER_BIN at the binary`);
    const holderLogFd = openSync(resolve(getHomeDir(), 'ttym.log'), 'a');
    const env = buildSessionEnv(extraEnv);
    const proc = spawn(bin, args, {
      detached: true,
      stdio: ['ignore', holderLogFd, holderLogFd],
      env,
    });
    const spawnFailed = new Promise<never>((_, reject) => proc.once('error', (e) => reject(new Error(`holder spawn failed: ${e.message}`))));
    spawnFailed.catch(() => {});
    proc.unref();

    // Wait for socket to appear (holder needs a moment)
    // 10s, not 3: on a machine already running a fleet of agents, a holder
    // plus its shell can take longer than 3s to reach the socket, and the old
    // limit turned load into spurious 'spawn failed' errors.
    await Promise.race([waitForSocket(socketPath, 10_000), spawnFailed]);

    // Connect and wait for STATE
    const sock = await connectSocket(socketPath);
    const session = new Session(id, cmd, cols, rows, proc.pid ?? 0, 0, Date.now());
    session.holderProc = proc;

    await session.connectHolder(sock);

    return session;
  }

  /** Recover an existing session from a running holder */
  static async recover(
    manifest: HolderManifest,
    runtimeDir: string,
    takeover = false,
    checkpoint?: { generation: string; offset: number; screen: string; cursor?: { x: number; y: number } },
  ): Promise<Session> {
    const sock = await connectSocket(manifest.socket);

    const session = new Session(
      manifest.id, manifest.cmd,
      manifest.cols, manifest.rows,
      manifest.pid, manifest.childPid,
      manifest.createdAt,
    );

    await session.connectHolder(sock, true, takeover, checkpoint);

    return session;
  }

  /** Connect to holder socket, receive STATE + DUMP for initial catch-up */
  connectHolder(
    sock: Socket,
    _recovery = false,
    takeover = false,
    checkpoint?: { generation: string; offset: number; screen: string; cursor?: { x: number; y: number } },
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sock = sock;
      this.debug(`connectHolder recovery=${_recovery} takeover=${takeover}`);
      let gotState = false;
      let pendingDump = false;
      let awaitingLease = false;
      let pendingReplay = false;
      const buffered: Array<{ cmd: number; payload: Buffer }> = [];

      /**
       * Catch the terminal up to the holder.
       *
       * With a checkpoint for this same holder incarnation we seed the screen
       * from it and ask only for the bytes after it — the checkpoint holds a
       * full 3000-row screen in ~571KB where the raw ring holds roughly a third
       * of that. Without one, or against an older holder, fall back to
       * replaying the whole ring.
       */
      const requestReplay = () => {
        const usable = checkpoint
          && (!checkpoint.generation || !this._generation || checkpoint.generation === this._generation)
          && checkpoint.offset > 0;

        if (usable && this.supportsReplay) {
          if (this.seedCheckpoint(checkpoint!.generation, checkpoint!.offset, checkpoint!.screen, checkpoint!.cursor)) {
            pendingReplay = true;
            const payload = Buffer.allocUnsafe(8);
            payload.writeBigUInt64LE(BigInt(checkpoint!.offset), 0);
            this.debug(`replay from checkpoint offset=${checkpoint!.offset}`);
            writeFrame(sock, H_CMD_DUMP_SINCE, payload);
            return;
          }
        }
        pendingDump = true;
        writeFrame(sock, H_CMD_DUMP_REQ);
      };

      // 재시작 때는 수백 개가 한꺼번에 체크포인트를 파싱한다 — 메모리 압박에서 10초를 넘긴 적이 있다(11-05 prod, 7개).
      const timer = setTimeout(() => {
        this.debug(`handshake timeout recovery=${_recovery} gotState=${gotState} pendingDump=${pendingDump} buffered=${buffered.length}`);
        try { sock.destroy(); } catch {}
        reject(new HolderHandshakeTimeout(this.id));
      }, _recovery ? RECOVER_HANDSHAKE_MS : 10000);

      sock.on('data', (data: Buffer) => {
        this.reader.feed(data);
        for (const frame of this.reader.frames()) {
          if (!gotState && frame.cmd === H_CMD_STATE) {
            gotState = true;
            try {
              const state = JSON.parse(frame.payload.toString()) as HolderState;
              this.debug(`got STATE childPid=${state.childPid} cols=${state.cols} rows=${state.rows} alive=${state.alive}`);
              (this as any).childPid = state.childPid ?? this.childPid;
              this._cols = state.cols ?? this._cols;
              this._rows = state.rows ?? this._rows;
              this._generation = state.generation ?? '';
              this._appliedOffset = state.nextOffset ?? 0;
              this._receivedOffset = this._appliedOffset;
              // nextOffset only appears on holders that track stream position.
              this.supportsReplay = typeof state.nextOffset === 'number';
              this.holderCaps = Array.isArray(state.caps) ? state.caps : [];
              try { this.term.resize(this._cols, this._rows); } catch {}

              // Claim the controller role before touching the PTY. Holders
              // without the capability skip this entirely, so an older holder
              // never receives a frame it cannot parse.
              if (state.lease) {
                awaitingLease = true;
                writeFrame(sock, H_CMD_ACQUIRE, Buffer.from(JSON.stringify({
                  serverId: SERVER_INSTANCE_ID,
                  takeover,
                })));
                return;
              }

              requestReplay();
            } catch (e) {
              clearTimeout(timer);
              reject(e);
            }
            continue;
          }

          if (awaitingLease) {
            if (frame.cmd === H_CMD_ACQUIRED) {
              awaitingLease = false;
              this.debug(`lease acquired ${frame.payload.toString()}`);
              requestReplay();
              continue;
            }
            if (frame.cmd === H_CMD_DENIED) {
              awaitingLease = false;
              clearTimeout(timer);
              this.closed = true;
              this.debug('lease denied: another server holds this session');
              reject(new ControllerHeldError(this.id));
              return;
            }
            // Output can arrive while the claim is in flight; keep it.
            buffered.push(frame);
            continue;
          }

          if (pendingReplay) {
            if (frame.cmd === H_CMD_REPLAY) {
              pendingReplay = false;
              const base = Number(frame.payload.readBigUInt64LE(0));
              const end = Number(frame.payload.readBigUInt64LE(8));
              const gap = frame.payload[16] === 1;
              const data = Buffer.from(frame.payload.subarray(17));
              this._recoveryGap = gap;
              if (gap) this._integrity = 'degraded';
              this._receivedOffset = end;
              // 화면이 이 구간을 다 그린 뒤에 offset을 end로 올린다 (체크포인트가 앞서 나가지 않게).
              if (data.length === 0) this._appliedOffset = end;
              this.debug(`got REPLAY base=${base} end=${end} gap=${gap} bytes=${data.length}`);
              const finalize = () => {
                for (const f of buffered) this.handleHolderFrame(f.cmd, f.payload);
                buffered.length = 0;
                clearTimeout(timer);
                resolve();
              };
              if (data.length > 0) {
                this.term.write(data, () => { this._appliedOffset = end; this.processTerminalOutput(data, false); finalize(); });
              } else {
                finalize();
              }
              continue;
            }
            buffered.push(frame);
            continue;
          }

          if (pendingDump) {
            if (frame.cmd === H_CMD_DUMP_RESP) {
              pendingDump = false;
              this.debug(`got DUMP_RESP bytes=${frame.payload.length} buffered=${buffered.length}`);
              const finalize = () => {
                // Replay any DATA_OUT buffered during handshake
                for (const f of buffered) {
                  this.handleHolderFrame(f.cmd, f.payload);
                }
                buffered.length = 0;
                clearTimeout(timer);
                resolve();
              };
              // Seed authoritative terminal with holder dump and rebuild viewer replay
              if (frame.payload.length > 0) {
                this.resetSyncEmissionState('holder dump');
                const dump = Buffer.from(frame.payload);
                this.term.write(dump, () => {
                  this.processTerminalOutput(dump, false);
                  finalize();
                });
              } else {
                finalize();
              }
              continue;
            }
            // Buffer DATA_OUT during handshake to avoid double-write
            buffered.push(frame);
            continue;
          }

          // Normal processing after handshake
          this.handleHolderFrame(frame.cmd, frame.payload);
        }
      });

      sock.on('close', () => {
        this.debug(`socket close closed=${this.closed} viewers=${this.viewers.size}`);
        if (!this.closed) {
          this.closed = true;
          this._diedAt = Date.now();
          this._exitCode = -1;
          for (const cb of this.exitCbs) cb(-1);
          this.exitCbs = [];
        }
        this.sock = null;
      });
      sock.on('error', (err) => {
        this.debug(`socket error ${(err as Error).message}`);
      });
    });
  }

  /**
   * xterm 쓰기 대기열. appliedOffset은 "화면에 실제로 반영된 곳"이라 파싱이 끝난 콜백에서만 올린다 —
   * 받은 즉시 올리면 체크포인트가 아직 안 그린 화면에 앞선 offset을 붙였다.
   * 대기열이 PARSE_HIGH_WATER를 넘으면 holder 소켓을 멈춘다(xterm은 50MB 근처에서 예외를 던진다).
   */
  private queueParse(data: Buffer): void {
    this.parsePendingBytes += data.length;
    if (!this.parsePaused && this.parsePendingBytes > PARSE_HIGH_WATER && this.sock) {
      this.parsePaused = true;
      this.sock.pause();
      this.debug(`parse backlog ${this.parsePendingBytes}B — pausing holder socket`);
    }
    const done = () => {
      this.parsePendingBytes -= data.length;
      this._appliedOffset += data.length;
      this.processTerminalOutput(data, this.viewers.size > 0);
      if (this.parsePaused && this.parsePendingBytes < PARSE_LOW_WATER) {
        this.parsePaused = false;
        this.sock?.resume();
      }
    };
    try {
      this.term.write(data, done);
    } catch (err) {
      // 화면은 이 바이트를 놓쳤다. 스트림(ring·viewer)은 그대로 흐르게 하고, 화면은 degraded로 알린다.
      this._integrity = 'degraded';
      this.droppedParseBytes += data.length;
      this.debug(`term.write failed (${(err as Error).message}); screen degraded, dropped=${this.droppedParseBytes}`);
      done();
    }
  }

  private handleHolderFrame(cmd: number, payload: Buffer) {
    switch (cmd) {
      case H_CMD_DATA_OUT: {
        if (this.closed) return;
        if (payload.length < 4) return;
        // 복사한다: payload는 프레임 리더의 큰 수신 버퍼 일부라, xterm 대기열에 남는 동안 그 버퍼 전체를 붙잡는다.
        const data = Buffer.from(payload.subarray(4));
        this._receivedOffset += data.length;

        // A degraded screen heals only when the stream itself repaints from
        // scratch. RIS (ESC c) is that moment. The scan is naive — an ESC c
        // inside a string sequence would also match — but a false positive
        // merely ends the degraded state early, and real RIS mid-string does
        // not occur in practice.
        if (this._integrity === 'degraded' && data.includes('\x1bc')) {
          this._integrity = 'healthy';
          this.debug('integrity healed by RIS');
        }

        // Layer 2: headless xterm
        // The ring and sync filter run whether anyone is watching or not —
        // seq is the screen's version number, and skipping the ring while
        // unwatched made the screen change without the version moving: a
        // viewer re-attaching at its old fromSeq was told "you're current"
        // over a screen that wasn't. Only the viewer callbacks are gated,
        // and the gate is read at parse time so a viewer that attached while
        // this chunk sat in xterm's write queue still receives it.
        if (this.cold) {
          // 터미널이 내려가 있다: 순서대로 모아 두고 다시 세운 뒤 그린다.
          this.cold.backlog.push(data);
          this.cold.backlogBytes += data.length;
          this.lastOutputAt = Date.now();
          void this.ensureWarm();
        } else {
          this.queueParse(data);
        }
        this._dirty = true;
        this._rev++;
        this._lastDirtyAt = Date.now();
        break;
      }
      case H_CMD_EXIT: {
        const code = payload.length >= 4 ? payload.readInt32LE(0) : -1;
        this.debug(`holder EXIT code=${code}`);
        this.closed = true;
        this._diedAt = Date.now();
        this._exitCode = code;
        for (const cb of this.exitCbs) cb(code);
        this.exitCbs = [];
        break;
      }
      case H_CMD_EVICTED: {
        // Another server took the lease. The PTY is fine — this server just no
        // longer drives it, which is a different thing from the session dying.
        this.debug('controller lease revoked by another server');
        this.closed = true;
        this._evicted = true;
        this._diedAt = Date.now();
        this._exitCode = -2;
        for (const cb of this.exitCbs) cb(-2);
        this.exitCbs = [];
        break;
      }
      case H_CMD_GAP: {
        if (payload.length < 16) break;
        const from = Number(payload.readBigUInt64LE(0));
        const to = Number(payload.readBigUInt64LE(8));
        this.debug(`stream gap from=${from} to=${to}: screen degraded`);
        this._integrity = 'degraded';
        this._receivedOffset = to;
        // 대기열에 있는 바이트가 다 그려진 다음에 offset을 건너뛴다.
        if (this.cold) { void this.ensureWarm().then(() => this.term.write('', () => { this._appliedOffset = to; })); }
        else this.term.write('', () => { this._appliedOffset = to; });
        this._dirty = true;
        this._rev++;
        break;
      }
      case H_CMD_PONG:
        break;
    }
  }

  // ───── Public API (identical interface) ─────

  get status(): SessionStatus {
    if (this.closed) return 'dead';
    return this.viewers.size > 0 ? 'attached' : 'detached';
  }
  get detachedAt(): number | null { return this._detachedAt; }
  get cols(): number { return this._cols; }
  get rows(): number { return this._rows; }
  get isDead(): boolean { return this.closed; }
  get viewerCount(): number { return this.viewers.size; }

  addViewer(viewerId: string, dataCb: DataCb, mode: ViewerMode = 'readwrite'): void {
    this.viewers.set(viewerId, { dataCb, mode, paused: false });
    this._detachedAt = null;
  }

  removeViewer(viewerId: string): void {
    this.viewers.delete(viewerId);
    this.resyncCbs.delete(viewerId);
    this.releaseBorrow(viewerId); // 빌린 채 떠나면 자동 반납 — 데스크톱 원상복구
    if (this.viewers.size === 0) {
      this._detachedAt = Date.now();
    }
    // 쓰기 뷰어가 다 떠났으면 아무도 안 볼 때의 크기로. 좁은 화면의 여러 칸 보기가 칸 10개를
    // 19x54 로 줄이고 떠난 뒤 그대로 남던 것(bp, 10-28) — 그 크기로 에이전트가 줄을 접어 그린다.
    // 끊겼다 바로 다시 붙는 뷰어(망 흔들림·새로고침)에 크기가 출렁이지 않게 잠깐 기다린다.
    if (this.unwatched && !this.hasWriter()) {
      if (this.unwatchedTimer) clearTimeout(this.unwatchedTimer);
      this.unwatchedTimer = setTimeout(() => {
        this.unwatchedTimer = null;
        if (!this.unwatched || this.hasWriter() || this.closed) return;
        const { cols, rows } = this.unwatched;
        this.unwatched = null;
        if (cols !== this._cols || rows !== this._rows) this.resize(cols, rows);
      }, this.unwatchedRestoreMs);
      this.unwatchedTimer.unref?.();
    }
  }

  private hasWriter(): boolean {
    for (const v of this.viewers.values()) if (v.mode === 'readwrite') return true;
    return false;
  }

  // ── 아무도 안 볼 때의 크기 ──
  // 뷰어는 붙어 있는 동안만 PTY 크기를 정한다. 첫 뷰어가 바꾸기 직전 크기를 기억해 두고, 마지막 쓰기
  // 뷰어가 떠나면 되돌린다. 뷰어가 아닌 쪽의 크기(`ttym resize`, API)는 그 기억을 바꾼다 — 주인의 뜻이다.
  private unwatched: { cols: number; rows: number } | null = null;
  private unwatchedTimer: ReturnType<typeof setTimeout> | null = null;
  /** 마지막 쓰기 뷰어가 떠난 뒤 되돌리기까지. */
  unwatchedRestoreMs = 3_000;

  /** 뷰어가 보내 온 크기. 되돌릴 크기를 처음 한 번 적어 둔다. */
  viewerResize(cols: number, rows: number): void {
    if (this.unwatchedTimer) { clearTimeout(this.unwatchedTimer); this.unwatchedTimer = null; }
    if (!this.unwatched) this.unwatched = { cols: this._cols, rows: this._rows };
    this.resize(cols, rows);
  }

  /** 뷰어가 아닌 쪽이 정한 크기: 지금 바꾸고, 뷰어가 다 떠난 뒤에도 이 크기. */
  ownerResize(cols: number, rows: number): void {
    if (this.unwatched) this.unwatched = { cols, rows };
    this.resize(cols, rows);
  }

  // ── 기하 빌림 장부 — 폰의 [맞춤] 토글이 PTY를 빌려 쓰고 돌려놓는다 ──
  private borrow: { prevCols: number; prevRows: number; viewerId: string } | null = null;

  /** 빌림 resize: 최초 1회 이전 기하를 기억한다. 같은/다른 viewer의 재빌림은 장부 갱신만. */
  borrowResize(viewerId: string, cols: number, rows: number): void {
    if (!this.borrow) this.borrow = { prevCols: this._cols, prevRows: this._rows, viewerId };
    else this.borrow.viewerId = viewerId;
    this.viewerResize(cols, rows);
  }

  /** 반납: 그 viewer가 빌린 상태일 때만 이전 기하로 복원 (브로드캐스트는 resize가 한다). */
  releaseBorrow(viewerId: string): void {
    if (!this.borrow || this.borrow.viewerId !== viewerId) return;
    const { prevCols, prevRows } = this.borrow;
    this.borrow = null;
    this.resize(prevCols, prevRows);
  }

  // ── Sleep support: an input gate and a frozen screen ──────────────────
  // While an agent is asleep (its process gone, the shell idle underneath),
  // input must wake it instead of reaching the shell, and viewers must keep
  // seeing the agent's last screen rather than the shell prompt. Both live
  // here because every input path ends in write() and every output path in
  // emitViewerChunk(); the sleeper only installs and removes them.

  /** Consumes input while set. Return true to swallow the bytes (they were queued). */
  inputGate: ((data: Buffer) => boolean) | null = null;
  private frozen: { snapshot: string; seq: number } | null = null;
  /** Wall-clock of the last real input / output — the idle clocks. */
  lastInputAt = 0;
  lastOutputAt = 0;
  /** Wall-clock of the last lone Esc key — a person stopping the agent's turn on purpose. */
  lastEscAt = 0;

  /** Stop forwarding output to viewers; they keep the screen as it is now. */
  freeze(snapshot?: string): void {
    this.frozen = { snapshot: snapshot ?? this.viewerSnapshot(), seq: this.lastSeq };
  }
  /** Forward output again. The caller re-snapshots viewers; nothing here replays what was hidden. */
  thaw(): void { this.frozen = null; }
  get isFrozen(): boolean { return this.frozen !== null; }
  /** The screen a viewer should see while frozen, and the seq it stands for. */
  frozenView(): { snapshot: string; seq: number } | null { return this.frozen; }

  /** Per-viewer "send me a fresh snapshot" hooks — the connection layer registers them. */
  private resyncCbs = new Map<string, () => void>();
  onResync(viewerId: string, cb: () => void): void { this.resyncCbs.set(viewerId, cb); }
  /** Every viewer gets the current screen as one snapshot (after thaw: the hidden delta is skipped). */
  resyncAll(): void { for (const cb of this.resyncCbs.values()) { try { cb(); } catch {} } }

  /** Bypass the gate — the sleeper's own commands to the shell. */
  writeRaw(data: Buffer): void {
    if (this.closed || !this.sock) return;
    writeFrame(this.sock, H_CMD_DATA_IN, data);
  }

  hasViewer(viewerId: string): boolean { return this.viewers.has(viewerId); }
  getViewer(viewerId: string): Viewer | undefined { return this.viewers.get(viewerId); }

  pauseViewer(viewerId: string): void {
    const v = this.viewers.get(viewerId);
    if (v) v.paused = true;
  }

  resumeViewer(viewerId: string): void {
    const v = this.viewers.get(viewerId);
    if (v) v.paused = false;
  }

  shouldForceSnapshotReplay(): boolean {
    return this.syncFilter.syncOpen;
  }

  snapshot(): string {
    if (this.cold) return inflateSync(this.cold.full).toString();
    return this.serializer.serialize();
  }

  /**
   * Viewer resync snapshot: recent scrollback only. Serialize is synchronous
   * CPU on the event loop and the client parses the result on its main
   * thread — a refresh of N fat panes at full 3000-line history is exactly
   * how a reload turns into seconds of loading. Checkpoints and /screen keep
   * the full serialize; a viewer joining live gets the tmux-attach deal.
   */
  viewerSnapshot(): string {
    if (this.cold) return inflateSync(this.cold.viewer).toString();
    return this.serializer.serialize({ scrollback: 1000 });
  }

  /**
   * Mark the row the next output will land on, so a later call can read back
   * everything written since.
   *
   * A plain `baseY + cursorY` stops meaning the same row once the scrollback
   * starts discarding lines: the number stays in range and quietly points at
   * unrelated output. An xterm marker follows the row and reports `line === -1`
   * once that row scrolls away, which is what lets `transcriptSince` tell "the
   * range is gone" apart from "the range is empty".
   */
  markCursor(): TerminalMarker | null {
    this.lastMarkAt = Date.now();
    if (this.cold) {
      // 다시 세운 직후(그 뒤 출력보다 앞)에 진짜 마커를 찍는다. 그때까지 line은 -1(범위 없음).
      const slot: { real: TerminalMarker | null } = { real: null };
      this.pendingMarkers.push(slot);
      void this.ensureWarm();
      return {
        get line() { return slot.real ? slot.real.line : -1; },
        dispose() { slot.real?.dispose(); },
      };
    }
    return this.term.registerMarker(0) ?? null;
  }

  /**
   * Rendered rows from `marker` up to the cursor.
   *
   * Returns null once the marker has scrolled out of the buffer — any range we
   * could return at that point would be someone else's output.
   */
  transcriptSince(marker: TerminalMarker): string | null {
    if (this.cold || marker.line < 0) return null;
    const buf = this.term.buffer.active;
    const end = buf.baseY + buf.cursorY;
    const rows: string[] = [];
    for (let i = marker.line; i <= end; i++) {
      const line = buf.getLine(i);
      if (line) rows.push(line.translateToString(true));
    }
    while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
    return rows.join('\n');
  }

  /** 보이는 화면의 아래 `max`줄(내용 있는 마지막 줄 기준), 색과 함께 — 호버 미리보기. */
  /** The cursor within screenTail(max)'s rows, or null. */
  tailCursor(max: number): { x: number; y: number } | null {
    if (this.cold) {
      const c = this.cold;
      if (!c.cursor) return null;
      const shown = Math.min(Math.max(0, max), c.tail.length);
      const y = c.cursor.y - (c.tail.length - shown);
      return y >= 0 ? { x: c.cursor.x, y } : null;
    }
    return tailCursor(this.term, max);
  }

  screenTail(max: number): ScreenRun[][] {
    if (this.cold) return max >= this.cold.tail.length ? this.cold.tail : this.cold.tail.slice(this.cold.tail.length - Math.max(0, max));
    return screenTail(this.term, max);
  }

  /** Cursor on the live screen, 0-based — stored with snapshots (see cursorTo). */
  cursorPos(): { x: number; y: number } | null {
    if (this.cold) return this.cold.pos;
    const buf = this.term.buffer.active;
    return { x: buf.cursorX, y: buf.cursorY };
  }

  /** The visible screen as plain rows — what `ttym screen` shows, without escape codes. */
  screenText(): string {
    if (this.cold) return this.cold.text;
    const buf = this.term.buffer.active;
    const rows: string[] = [];
    for (let i = 0; i < this.term.rows; i++) rows.push(buf.getLine(buf.viewportY + i)?.translateToString(true) ?? '');
    return rows.join('\n').replace(/\s+$/, '');
  }

  /** Seed headless xterm with a previously saved snapshot (for reboot restore) */
  seedSnapshot(ansi: string): void {
    this.resetSyncEmissionState('seed snapshot');
    this.term.write(ansi);
  }

  /** Ring sequence of the last appended output — the snapshot watermark. */
  get lastSeq(): number {
    return this.ring.nextSeq - 1;
  }

  info(): SessionInfo {
    return {
      id: this.id,
      pid: this.childPid,
      cmd: this.cmd,
      cols: this._cols,
      rows: this._rows,
      status: this.status,
      viewerCount: this.viewers.size,
      lastSeq: this.lastSeq,
      createdAt: this.createdAt,
      detachedAt: this._detachedAt,
    };
  }

  private geometryListeners = new Set<(cols: number, rows: number) => void>();

  /** PTY 기하가 바뀔 때 — follow 모드 뷰어(모바일)가 서버 기하를 추종하는 통로. */
  onGeometry(cb: (cols: number, rows: number) => void): () => void {
    this.geometryListeners.add(cb);
    return () => this.geometryListeners.delete(cb);
  }

  onExit(cb: ExitCb): void {
    if (this.closed) { cb(-1); return; }
    this.exitCbs.push(cb);
  }

  write(data: Buffer): void {
    if (this.closed || !this.sock) return;
    if (this.inputGate && this.inputGate(data)) return;
    this.lastInputAt = Date.now();
    // The Esc key alone (arrows and the like are \x1b[…, not this). Twice is still a press.
    if (data.length > 0 && data.length <= 2 && data.every((b) => b === 0x1b)) this.lastEscAt = this.lastInputAt;
    writeFrame(this.sock, H_CMD_DATA_IN, data);
  }

  resize(cols: number, rows: number): void {
    if (this.closed || !this.sock) return;
    this._cols = cols;
    this._rows = rows;
    this.resetSyncEmissionState('resize');
    const payload = Buffer.allocUnsafe(4);
    payload.writeUInt16LE(cols, 0);
    payload.writeUInt16LE(rows, 2);
    writeFrame(this.sock, H_CMD_RESIZE, payload);
    // 내려간 터미널은 다시 세울 때 이 크기로 맞춘다(ensureWarm). 화면이 다시 흐를 것이므로 깨운다.
    if (this.cold) void this.ensureWarm();
    else { try { this.term.resize(cols, rows); } catch {} }
    for (const listener of this.geometryListeners) {
      try { listener(cols, rows); } catch {}
    }
  }

  pause(): void {
    // No-op: holder manages PTY directly, backpressure is per-viewer now
  }

  resume(): void {
    // No-op: same reason
  }

  kill(): void {
    if (this.closed) return;
    this.clearSyncTimer();
    this.closed = true;
    this.viewers.clear();
    if (this.sock) {
      writeFrame(this.sock, H_CMD_KILL);
      this.sock.destroy();
      this.sock = null;
    }
    // 내려간 상태면 term이 없다. 다시 세우는 중이면 새로 만든 term이 있다 — 있으면 해제한다.
    try { this.term?.dispose(); } catch {}
    this.cold = null;
    this.ring.clear();
  }

  private processTerminalOutput(data: Buffer, broadcast: boolean): void {
    if (!ENABLE_SYNC_BLOCK_COALESCING) {
      this.emitViewerChunk(data, broadcast);
      return;
    }

    const result = this.syncFilter.process(data);
    if (result.syncStarted) {
      this.syncBlocksStarted += 1;
      this.armSyncTimer();
      syncTotals.sessions.add(this.id);
      this.trace(`sync start count=${this.syncBlocksStarted}`);
    }
    if (result.overflowed) {
      this.syncOverflowCount += 1;
      this.clearSyncTimer();
      syncTotals.overflow += 1;
      this.debug(`sync overflow count=${this.syncOverflowCount}`);
    }
    if (result.syncEnded) {
      this.syncBlocksCompleted += 1;
      this.clearSyncTimer();
      this.syncBufferedBytes += data.length;
      this.syncEmittedBytes += result.coalescedBytes;
      syncTotals.blocks += 1;
      syncTotals.sessions.add(this.id);
      syncTotals.rawBytes += data.length;
      syncTotals.emittedBytes += result.coalescedBytes;
      this.trace(
        `sync end count=${this.syncBlocksCompleted} raw=${data.length} emitted=${result.coalescedBytes} open=${result.syncOpen}`,
      );
    }

    // 필터는 escape 경계마다 조각을 낸다(실측: 6.1MB → 72만 조각, 중앙값 4바이트). 조각마다 ring에
    // Chunk·Buffer 객체가 생겨 4MB ring 하나가 JS 힙 78MB가 됐다(2026-11-06 프로파일). 한 번의 PTY 읽기에서
    // 나온 것은 한 조각으로 넣는다 — 명령 경계 seq는 term.write 중에 nextSeq로 찍히므로 정밀도는 그대로다.
    const emitted = result.emitted;
    if (emitted.length === 1) this.emitViewerChunk(emitted[0]!, broadcast);
    else if (emitted.length > 1) this.emitViewerChunk(Buffer.concat(emitted), broadcast);
  }

  private emitViewerChunk(data: Buffer, broadcast: boolean): void {
    if (data.length === 0) return;
    const viewerSeq = this.ring.push(data);
    this.lastOutputAt = Date.now();
    if (!broadcast || this.frozen) return;
    for (const viewer of this.viewers.values()) {
      if (!viewer.paused) viewer.dataCb(data, viewerSeq);
    }
  }

  private resetSyncEmissionState(reason: string): void {
    this.clearSyncTimer();
    const aborted = this.syncFilter.abortOpenBlock();
    if (aborted && aborted.length > 0) {
      syncTotals.resets += 1;
      this.debug(`sync reset reason=${reason} replaying-open-block-bytes=${aborted.length}`);
      this.emitViewerChunk(aborted, true);
    }
  }

  private armSyncTimer(): void {
    this.clearSyncTimer();
    this.syncTimer = setTimeout(() => {
      this.syncTimeoutCount += 1;
      syncTotals.timeout += 1;
      this.debug(`sync timeout count=${this.syncTimeoutCount}`);
      this.resetSyncEmissionState('timeout');
    }, getSyncBlockTimeoutMs());
  }

  private clearSyncTimer(): void {
    if (!this.syncTimer) return;
    clearTimeout(this.syncTimer);
    this.syncTimer = null;
  }
}

// ───── Holder manifest ─────

export interface HolderManifest {
  id: number;
  pid: number;
  childPid: number;
  cmd: string[];
  cols: number;
  rows: number;
  socket: string;
  createdAt: number;
}

// ───── Utilities ─────

function waitForSocket(path: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (existsSync(path)) { resolve(); return; }
      if (Date.now() - start > timeoutMs) { reject(new Error(`socket ${path} not ready`)); return; }
      setTimeout(check, 20);
    };
    check();
  });
}

function connectSocket(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(path, () => resolve(sock));
    sock.on('error', reject);
  });
}

interface HolderState {
  id: number;
  pid: number;
  childPid: number;
  cmd: string[];
  cols: number;
  rows: number;
  createdAt: number;
  nextSeq: number;
  alive: boolean;
  /** Present only on holders that implement the controller lease. */
  lease?: boolean;
  /** Holder capabilities (journal, gap). Absent on older holders. */
  caps?: string[];
  /** Whether another server currently holds it. */
  held?: boolean;
  /** Identifies this holder incarnation; a checkpoint is only valid against it. */
  generation?: string;
  /** Oldest byte still replayable, and the total written so far. */
  baseOffset?: number;
  nextOffset?: number;
}
