import * as pty from 'node-pty';
import kill from 'tree-kill';
import headless from '@xterm/headless';
const { Terminal } = headless;
import { SerializeAddon } from '@xterm/addon-serialize';
import { OutputRing } from './output-ring.js';

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  return env;
}

export type SessionStatus = 'attached' | 'detached' | 'dead';
export type ViewerMode = 'readwrite' | 'readonly';

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
  paused: boolean; // PAUSE_VIEW 상태
}

/**
 * 3계층 세션 — multi-viewer 지원
 *
 * Layer 1: node-pty — PTY 소유, WebSocket과 독립 수명
 * Layer 2: @xterm/headless + SerializeAddon — 서버 측 터미널 상태
 * Layer 3: OutputRing — seq 기반 transport recovery buffer
 */
export class Session {
  readonly id: number;
  readonly pid: number;
  readonly cmd: string[];
  readonly createdAt: number;

  // Layer 1: PTY
  private pty: pty.IPty;
  private closed = false;

  // Layer 2: Headless terminal state
  private term: InstanceType<typeof Terminal>;
  private serializer: SerializeAddon;

  // Layer 3: Ring buffer
  readonly ring: OutputRing;

  // Multi-viewer state
  private viewers = new Map<string, Viewer>();
  private _detachedAt: number | null = null;
  private exitCbs: ExitCb[] = [];

  constructor(id: number, cmd: string[], cols: number, rows: number) {
    this.id = id;
    this.cmd = cmd;
    this.createdAt = Date.now();

    // Layer 2: headless xterm
    this.term = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer as any);

    // Layer 3: ring buffer
    this.ring = new OutputRing(128 * 1024);

    // Layer 1: PTY
    this.pty = pty.spawn(cmd[0], cmd.slice(1), {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: process.env.HOME || '/tmp',
      env: cleanEnv(),
    });
    this.pid = this.pty.pid;

    // PTY output → Layer 2 (항상) + Layer 3 (항상) + viewers (broadcast)
    this.pty.onData((raw) => {
      if (this.closed) return;
      const data = Buffer.from(raw);

      // Layer 2: headless xterm에 항상 먹임
      this.term.write(data);

      // Layer 3: ring에 항상 적재
      const seq = this.ring.push(data);

      // broadcast to all non-paused viewers
      for (const viewer of this.viewers.values()) {
        if (!viewer.paused) {
          viewer.dataCb(data, seq);
        }
      }
    });

    this.pty.onExit(({ exitCode }) => {
      if (this.closed) return;
      this.closed = true;
      for (const cb of this.exitCbs) cb(exitCode);
      this.exitCbs = [];
    });
  }

  get status(): SessionStatus {
    if (this.closed) return 'dead';
    return this.viewers.size > 0 ? 'attached' : 'detached';
  }
  get detachedAt(): number | null { return this._detachedAt; }
  get cols(): number { return this.term.cols; }
  get rows(): number { return this.term.rows; }
  get isDead(): boolean { return this.closed; }
  get viewerCount(): number { return this.viewers.size; }

  // ───── Viewer 관리 ─────

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

  hasViewer(viewerId: string): boolean {
    return this.viewers.has(viewerId);
  }

  getViewer(viewerId: string): Viewer | undefined {
    return this.viewers.get(viewerId);
  }

  /** viewer별 PAUSE_VIEW */
  pauseViewer(viewerId: string): void {
    const v = this.viewers.get(viewerId);
    if (v) v.paused = true;
  }

  /** viewer별 RESUME_VIEW */
  resumeViewer(viewerId: string): void {
    const v = this.viewers.get(viewerId);
    if (v) v.paused = false;
  }

  /** 현재 터미널 화면을 VT sequence로 직렬화 */
  snapshot(): string {
    return this.serializer.serialize();
  }

  /** 세션 정보 */
  info(): SessionInfo {
    return {
      id: this.id,
      pid: this.pid,
      cmd: this.cmd,
      cols: this.term.cols,
      rows: this.term.rows,
      status: this.status,
      viewerCount: this.viewers.size,
      lastSeq: this.ring.nextSeq - 1,
      createdAt: this.createdAt,
      detachedAt: this._detachedAt,
    };
  }

  onExit(cb: ExitCb): void {
    if (this.closed) { cb(-1); return; }
    this.exitCbs.push(cb);
  }

  /** readwrite viewer만 write 가능 (서버에서 체크) */
  write(data: Buffer): void {
    if (this.closed) return;
    try { this.pty.write(data.toString()); } catch {}
  }

  resize(cols: number, rows: number): void {
    if (this.closed) return;
    try {
      this.pty.resize(cols, rows);
      this.term.resize(cols, rows);
    } catch {}
  }

  pause(): void {
    if (this.closed) return;
    try { this.pty.pause(); } catch {}
  }

  resume(): void {
    if (this.closed) return;
    try { this.pty.resume(); } catch {}
  }

  kill(): void {
    if (this.closed) return;
    this.closed = true;
    this.viewers.clear();
    try { this.pty.kill(); } catch {}
    if (this.pid > 0) {
      const pid = this.pid;
      kill(pid, 'SIGHUP', () => {
        setTimeout(() => kill(pid, 'SIGKILL', () => {}), 100);
      });
    }
    this.term.dispose();
    this.ring.clear();
  }
}
