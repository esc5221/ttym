import { spawn, ChildProcess } from 'node:child_process';
import { createConnection, Socket } from 'node:net';
import { existsSync, openSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import headless from '@xterm/headless';
const { Terminal } = headless;
import { SerializeAddon } from '@xterm/addon-serialize';
import { OutputRing } from './output-ring.js';
import { SyncBlockFilter } from './sync-block.js';

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

const DEFAULT_RING_BYTES = 1024 * 1024;

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
const H_CMD_REPLAY = 0x11;

/** Identifies this server process to holders, so an eviction is attributable. */
const SERVER_INSTANCE_ID = `srv-${process.pid}-${Date.now().toString(36)}`;

/** Raised when another server already holds the PTY and takeover was not asked for. */
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

export function getRuntimeDir(): string {
  const env = process.env;
  if (env.TTYM_RUNTIME_DIR) return env.TTYM_RUNTIME_DIR;
  return resolve(getHomeDir(), 'run');
}

// ───── Holder binary path ─────

function holderBin(): string {
  if (process.env.TTYM_HOLDER_BIN) return process.env.TTYM_HOLDER_BIN;
  // 1. Same directory as this script (bundled dist/)
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const samedir = resolve(__dirname, 'ttym-holder');
  if (existsSync(samedir)) return samedir;
  // 2. Dev: relative to packages/server/src/
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
  private term: InstanceType<typeof Terminal>;
  private serializer: SerializeAddon;

  // Layer 3: Ring buffer (for viewer delta replay)
  readonly ring: OutputRing;

  // Multi-viewer state
  private viewers = new Map<string, Viewer>();
  private _detachedAt: number | null = null;
  private exitCbs: ExitCb[] = [];
  private _cols: number;
  private _rows: number;
  private _dirty = false;
  private _lastDirtyAt = 0;
  private _diedAt = 0;
  private _evicted = false;
  private _generation = '';
  private _appliedOffset = 0;
  private _recoveryGap = false;
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

  get dirty(): boolean { return this._dirty; }
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
  /** Exit code once the PTY has died; -1 unknown, -2 lease lost. */
  get exitCode(): number | null { return this._exitCode; }

  /**
   * Seed the terminal from a saved checkpoint before any delta is applied.
   * Returns false when the checkpoint belongs to a different holder incarnation.
   */
  seedCheckpoint(generation: string, offset: number, screen: string): boolean {
    if (generation && this._generation && generation !== this._generation) return false;
    this.resetSyncEmissionState('seed checkpoint');
    this.term.write(screen);
    this._appliedOffset = offset;
    return true;
  }

  /** Per-row soft-wrap flags, so a resize can reflow what was restored. */
  wrapFlags(): string {
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

    // Layer 2
    this.term = new Terminal({ cols, rows, scrollback: 3000, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer as any);

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
  }

  /** Create a new session: spawn holder, connect */
  static async create(
    id: number, cmd: string[], cols: number, rows: number,
    runtimeDir: string, cwd?: string, extraEnv?: Record<string, string>,
  ): Promise<Session> {
    const socketPath = resolve(runtimeDir, `session-${id}.sock`);

    // Spawn holder (detached, survives server exit)
    // stdio must be 'ignore' — pipe would kill holder on SIGPIPE when server exits
    const args = [
      '--id', String(id),
      '--cols', String(cols),
      '--rows', String(rows),
      '--runtime-dir', runtimeDir,
    ];
    if (cwd) args.push('--cwd', cwd);
    args.push('--', ...cmd);

    const holderLogFd = openSync(resolve(getHomeDir(), 'ttym.log'), 'a');
    const env = buildSessionEnv(extraEnv);
    const proc = spawn(holderBin(), args, {
      detached: true,
      stdio: ['ignore', holderLogFd, holderLogFd],
      env,
    });
    proc.unref();

    // Wait for socket to appear (holder needs a moment)
    // 10s, not 3: on a machine already running a fleet of agents, a holder
    // plus its shell can take longer than 3s to reach the socket, and the old
    // limit turned load into spurious 'spawn failed' errors.
    await waitForSocket(socketPath, 10_000);

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
    checkpoint?: { generation: string; offset: number; screen: string },
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
    checkpoint?: { generation: string; offset: number; screen: string },
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
          if (this.seedCheckpoint(checkpoint!.generation, checkpoint!.offset, checkpoint!.screen)) {
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

      const timer = setTimeout(() => {
        this.debug(`handshake timeout recovery=${_recovery} gotState=${gotState} pendingDump=${pendingDump} buffered=${buffered.length}`);
        reject(new Error('holder handshake timeout'));
      }, 10000);

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
              // nextOffset only appears on holders that track stream position.
              this.supportsReplay = typeof state.nextOffset === 'number';
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
              this._appliedOffset = end;
              this.debug(`got REPLAY base=${base} end=${end} gap=${gap} bytes=${data.length}`);
              const finalize = () => {
                for (const f of buffered) this.handleHolderFrame(f.cmd, f.payload);
                buffered.length = 0;
                clearTimeout(timer);
                resolve();
              };
              if (data.length > 0) {
                this.term.write(data, () => { this.processTerminalOutput(data, false); finalize(); });
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

  private handleHolderFrame(cmd: number, payload: Buffer) {
    switch (cmd) {
      case H_CMD_DATA_OUT: {
        if (this.closed) return;
        if (payload.length < 4) return;
        const data = payload.subarray(4);
        // Track the stream position so a checkpoint can say how far the screen
        // has been advanced. The holder counts the same bytes, so starting from
        // the offset it reported in STATE keeps the two in step.
        this._appliedOffset += data.length;

        // Layer 2: headless xterm
        // The ring and sync filter run whether anyone is watching or not —
        // seq is the screen's version number, and skipping the ring while
        // unwatched made the screen change without the version moving: a
        // viewer re-attaching at its old fromSeq was told "you're current"
        // over a screen that wasn't. Only the viewer callbacks are gated,
        // and the gate is read at parse time so a viewer that attached while
        // this chunk sat in xterm's write queue still receives it.
        this.term.write(data, () => {
          this.processTerminalOutput(data, this.viewers.size > 0);
        });
        this._dirty = true;
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
    if (this.viewers.size === 0) {
      this._detachedAt = Date.now();
    }
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
    return this.term.registerMarker(0) ?? null;
  }

  /**
   * Rendered rows from `marker` up to the cursor.
   *
   * Returns null once the marker has scrolled out of the buffer — any range we
   * could return at that point would be someone else's output.
   */
  transcriptSince(marker: TerminalMarker): string | null {
    if (marker.line < 0) return null;
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

  onExit(cb: ExitCb): void {
    if (this.closed) { cb(-1); return; }
    this.exitCbs.push(cb);
  }

  write(data: Buffer): void {
    if (this.closed || !this.sock) return;
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
    try { this.term.resize(cols, rows); } catch {}
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
    this.term.dispose();
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
      this.debug(`sync start count=${this.syncBlocksStarted}`);
    }
    if (result.overflowed) {
      this.syncOverflowCount += 1;
      this.clearSyncTimer();
      this.debug(`sync overflow count=${this.syncOverflowCount}`);
    }
    if (result.syncEnded) {
      this.syncBlocksCompleted += 1;
      this.clearSyncTimer();
      this.syncBufferedBytes += data.length;
      this.syncEmittedBytes += result.coalescedBytes;
      this.debug(
        `sync end count=${this.syncBlocksCompleted} raw=${data.length} emitted=${result.coalescedBytes} open=${result.syncOpen}`,
      );
    }

    for (const chunk of result.emitted) {
      this.emitViewerChunk(chunk, broadcast);
    }
  }

  private emitViewerChunk(data: Buffer, broadcast: boolean): void {
    if (data.length === 0) return;
    const viewerSeq = this.ring.push(data);
    if (!broadcast) return;
    for (const viewer of this.viewers.values()) {
      if (!viewer.paused) viewer.dataCb(data, viewerSeq);
    }
  }

  private resetSyncEmissionState(reason: string): void {
    this.clearSyncTimer();
    const aborted = this.syncFilter.abortOpenBlock();
    if (aborted && aborted.length > 0) {
      this.debug(`sync reset reason=${reason} replaying-open-block-bytes=${aborted.length}`);
      this.emitViewerChunk(aborted, true);
    }
  }

  private armSyncTimer(): void {
    this.clearSyncTimer();
    this.syncTimer = setTimeout(() => {
      this.syncTimeoutCount += 1;
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
  /** Whether another server currently holds it. */
  held?: boolean;
  /** Identifies this holder incarnation; a checkpoint is only valid against it. */
  generation?: string;
  /** Oldest byte still replayable, and the total written so far. */
  baseOffset?: number;
  nextOffset?: number;
}
