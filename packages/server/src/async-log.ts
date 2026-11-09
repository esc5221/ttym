/**
 * stdout·stderr가 파일이면 node는 동기로 쓴다(SyncWriteStream → fs.writeSync). 디스크가 밀리면 로그 한 줄이
 * event loop 전체를 세운다 — 압박 벤치(2026-11-08)에서 console.log 하나가 writeSync에 32초 묶였다(cpu-prof).
 * 운영도 같다: launchd StandardOutPath·systemd append: 가 ttym.log 파일이다.
 *
 * 여기서는 그 쓰기를 큐에 담아 libuv 스레드에서 차례로 쓴다. 같은 파일을 가리키는 1·2는 큐 하나(줄 순서 유지).
 * 디스크가 막혀 큐가 상한을 넘으면 새 로그는 버리고, 다시 흐를 때(또는 종료 때) 버린 양을 한 줄 남긴다.
 *
 * 종료: 정상 종료는 drain()으로 쓰는 중인 것까지 끝낸 뒤 나간다(index.ts shutdown). 'exit'에서의 flushSync는
 * 마지막 수단이다 — 쓰는 중인 조각은 다시 쓰지 않는다(쓰기 syscall은 이미 커널에 들어가 있어 중복이 된다,
 * 2026-11-09 리뷰에서 재현). 남은 큐만 짧은 쓰기까지 이어서 동기로.
 */
import { fstatSync, write as fsWrite, writeSync } from 'node:fs';

const MAX_QUEUED = 4 << 20;

type WriteFn = (fd: number, buf: Buffer, cb: (err: NodeJS.ErrnoException | null, written: number) => void) => void;

export interface AsyncLog {
  write(chunk: Buffer): void;
  /** 쓰는 중인 것과 큐를 모두 쓴 뒤 끝난다(최대 timeoutMs). */
  drain(timeoutMs?: number): Promise<void>;
  /**
   * 마지막 수단('exit'): 큐에 남은 것을 동기로. 쓰는 중인 조각은 기본으로 다시 쓰지 않는다(중복).
   * includeInFlight: 오류로 끝날 때 — 마지막 오류 줄이 아직 스레드풀 대기열에 있으면 잃는다. 중복이 잃는 것보다 낫다.
   */
  flushSync(includeInFlight?: boolean): void;
  readonly queued: number;
  readonly dropped: number;
}

function writeAllSync(fd: number, b: Buffer): void {
  let off = 0;
  for (let tries = 0; off < b.length && tries < 1000; tries++) {
    try { off += writeSync(fd, b, off, b.length - off); } catch { return; }
  }
}

export function createAsyncLog(fd: number, opts: { max?: number; write?: WriteFn; writeSync?: (fd: number, b: Buffer) => void } = {}): AsyncLog {
  const max = opts.max ?? MAX_QUEUED;
  const doWrite: WriteFn = opts.write ?? ((f, b, cb) => fsWrite(f, b, 0, b.length, null, cb));
  const doWriteSync = opts.writeSync ?? writeAllSync;
  const q: Buffer[] = [];
  let queued = 0;
  let dropped = 0;
  let droppedTotal = 0;
  let inFlight: Buffer | null = null;
  let idle: Array<() => void> = [];

  const note = () => Buffer.from(`[log] dropped ${dropped} bytes while the disk was not keeping up\n`);
  const pump = () => {
    if (inFlight) return;
    if (q.length === 0) { const w = idle; idle = []; for (const f of w) f(); return; }
    const buf = q.length === 1 ? q[0]! : Buffer.concat(q);
    q.length = 0;
    inFlight = buf;
    doWrite(fd, buf, (err, n) => {
      inFlight = null;
      queued -= buf.length;
      if (!err && n < buf.length) { const rest = buf.subarray(n); q.unshift(rest); queued += rest.length; }
      pump();
    });
  };

  return {
    write(chunk) {
      // 상한은 안내 줄까지 포함해서 센다
      if (queued + chunk.length + (dropped > 0 ? 80 : 0) > max) { dropped += chunk.length; droppedTotal += chunk.length; return; }
      if (dropped > 0) {
        const n = note();
        dropped = 0;
        q.push(n); queued += n.length;
      }
      q.push(chunk); queued += chunk.length;
      pump();
    },
    drain(timeoutMs = 3000) {
      if (dropped > 0) { const n = note(); dropped = 0; q.push(n); queued += n.length; pump(); }
      if (!inFlight && q.length === 0) return Promise.resolve();
      return new Promise((resolve) => {
        const t = setTimeout(resolve, timeoutMs);
        idle.push(() => { clearTimeout(t); resolve(); });
      });
    },
    flushSync(includeInFlight = false) {
      if (dropped > 0) { q.push(note()); dropped = 0; }
      const rest = [...(includeInFlight && inFlight ? [inFlight] : []), ...q];
      inFlight = null;
      q.length = 0;
      for (const b of rest) doWriteSync(fd, b);
    },
    get queued() { return queued; },
    get dropped() { return droppedTotal; },
  };
}

const installed: AsyncLog[] = [];

/** process.stdout·stderr 중 파일인 것을 비동기 큐로 바꾼다. TTY·파이프는 그대로. */
export function installAsyncStdio(): void {
  const byIno = new Map<string, AsyncLog>();
  for (const [stream, fd] of [[process.stdout, 1], [process.stderr, 2]] as const) {
    let key: string;
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) continue;
      key = `${st.dev}:${st.ino}`;
    } catch { continue; }
    let log = byIno.get(key);
    if (!log) { log = createAsyncLog(fd); byIno.set(key, log); installed.push(log); const l = log; process.on('exit', (code) => l.flushSync(code !== 0)); }
    const l = log;
    (stream as unknown as { write: unknown }).write = (chunk: unknown, enc?: unknown, cb?: unknown) => {
      const b = Buffer.isBuffer(chunk) ? chunk
        : chunk instanceof Uint8Array ? Buffer.from(chunk)
        : Buffer.from(String(chunk), typeof enc === 'string' ? (enc as BufferEncoding) : 'utf8');
      l.write(b);
      const done = typeof enc === 'function' ? enc : cb;
      if (typeof done === 'function') queueMicrotask(() => (done as () => void)());
      return true;
    };
  }
}

/** 정상 종료 직전: 설치된 로그 큐를 모두 비운다. */
export function drainAsyncStdio(timeoutMs = 3000): Promise<void> {
  return Promise.all(installed.map((l) => l.drain(timeoutMs))).then(() => undefined);
}
