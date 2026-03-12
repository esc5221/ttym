import * as pty from 'node-pty';
import kill from 'tree-kill';

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  return env;
}

export class Session {
  readonly id: number;
  readonly pid: number;
  private pty: pty.IPty;
  private paused = false;
  private closed = false;
  private exitCallbacks: ((code: number) => void)[] = [];

  constructor(id: number, cmd: string[], cols: number, rows: number) {
    this.id = id;
    this.pty = pty.spawn(cmd[0], cmd.slice(1), {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: process.env.HOME || '/tmp',
      env: cleanEnv(),
    });
    this.pid = this.pty.pid;

    this.pty.onExit(({ exitCode }) => {
      if (this.closed) return;
      this.closed = true;
      for (const cb of this.exitCallbacks) cb(exitCode);
      this.exitCallbacks = [];
    });
  }

  onData(cb: (data: Buffer) => void) {
    if (this.closed) return;
    this.pty.onData((data) => {
      if (this.closed || this.paused) return;
      // UTF-8 기본 인코딩 — 한국어/CJK 정상 처리
      cb(Buffer.from(data));
    });
  }

  onExit(cb: (code: number) => void) {
    if (this.closed) return;
    this.exitCallbacks.push(cb);
  }

  write(data: Buffer) {
    if (this.closed) return;
    try { this.pty.write(data.toString()); } catch {}
  }

  resize(cols: number, rows: number) {
    if (this.closed) return;
    try { this.pty.resize(cols, rows); } catch {}
  }

  pause() {
    if (this.closed || this.paused) return;
    this.paused = true;
    try { this.pty.pause(); } catch {}
  }

  resume() {
    if (this.closed || !this.paused) return;
    this.paused = false;
    try { this.pty.resume(); } catch {}
  }

  kill() {
    if (this.closed) return;
    this.closed = true;
    // SIGHUP 먼저 (graceful), 100ms 후 SIGKILL (강제)
    try { this.pty.kill(); } catch {}
    if (this.pid > 0) {
      const pid = this.pid;
      kill(pid, 'SIGHUP', () => {
        setTimeout(() => kill(pid, 'SIGKILL', () => {}), 100);
      });
    }
  }
}
