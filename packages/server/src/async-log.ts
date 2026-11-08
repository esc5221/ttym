/**
 * stdout·stderr가 파일이면 node는 동기로 쓴다(SyncWriteStream → fs.writeSync). 디스크가 밀리면 로그 한 줄이
 * event loop 전체를 세운다 — 압박 벤치(2026-11-08)에서 console.log 하나가 writeSync에 32초 묶였다(cpu-prof).
 * 운영도 같다: launchd StandardOutPath·systemd append: 가 ttym.log 파일이다.
 *
 * 여기서는 그 쓰기를 큐에 담아 libuv 스레드에서 차례로 쓴다. 같은 파일을 가리키는 1·2는 큐 하나(줄 순서 유지).
 * 디스크가 막혀 큐가 상한을 넘으면 새 로그는 버리고, 다시 흐를 때 버린 양을 한 줄 남긴다. 종료 때 남은 것은 동기로.
 */
import { fstatSync, write as fsWrite, writeSync } from 'node:fs';

const MAX_QUEUED = 4 << 20;

type WriteFn = (fd: number, buf: Buffer, cb: (err: NodeJS.ErrnoException | null, written: number) => void) => void;

export interface AsyncLog {
  write(chunk: Buffer): void;
  /** 남은 것을 동기로(종료 때) */
  flushSync(): void;
  readonly queued: number;
  readonly dropped: number;
}

export function createAsyncLog(fd: number, opts: { max?: number; write?: WriteFn } = {}): AsyncLog {
  const max = opts.max ?? MAX_QUEUED;
  const doWrite: WriteFn = opts.write ?? ((f, b, cb) => fsWrite(f, b, 0, b.length, null, cb));
  const q: Buffer[] = [];
  let queued = 0;
  let dropped = 0;
  let droppedTotal = 0;
  let inFlight: Buffer | null = null;

  const pump = () => {
    if (inFlight || q.length === 0) return;
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
      if (queued + chunk.length > max) { dropped += chunk.length; droppedTotal += chunk.length; return; }
      if (dropped > 0) {
        const note = Buffer.from(`[log] dropped ${dropped} bytes while the disk was not keeping up\n`);
        dropped = 0;
        q.push(note); queued += note.length;
      }
      q.push(chunk); queued += chunk.length;
      pump();
    },
    flushSync() {
      // 쓰는 중인 조각도 — 종료 때 스레드풀의 쓰기가 끝났는지 알 수 없다. 겹쳐 쓰는 편이 잃는 것보다 낫다.
      const rest = [...(inFlight ? [inFlight] : []), ...q];
      inFlight = null;
      q.length = 0;
      for (const b of rest) { try { writeSync(fd, b); } catch {} }
    },
    get queued() { return queued; },
    get dropped() { return droppedTotal; },
  };
}

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
    if (!log) { log = createAsyncLog(fd); byIno.set(key, log); const l = log; process.on('exit', () => l.flushSync()); }
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
