import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';
import { unlinkSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectSocketFresh } from './session.js';

// 소켓 파일은 bind()에서 생기고 listen()은 그 뒤 — 그 틈에 붙으면 ECONNREFUSED(2026-11-08 벤치·flaky 테스트).
let dir = '';
let server: Server | null = null;
let bound: ChildProcess | null = null;
afterEach(() => { server?.close(); server = null; bound?.kill('SIGKILL'); bound = null; if (dir) rmSync(dir, { recursive: true, force: true }); });

/** holder가 bind()만 하고 아직 listen()하지 않은 순간과 같은 소켓 — 진짜 소켓 파일이라야 ECONNREFUSED가 난다
 *  (보통 파일이면 macOS는 ENOTSOCK). node는 listen 없이 bind만 못 해서 python으로. */
async function bindOnly(path: string): Promise<ChildProcess> {
  const p = spawn('python3', ['-c', `import socket,time\ns=socket.socket(socket.AF_UNIX)\ns.bind(${JSON.stringify(path)})\ntime.sleep(30)`], { stdio: 'ignore' });
  for (let i = 0; i < 100 && !existsSync(path); i++) await new Promise((r) => setTimeout(r, 20));
  return p;
}

describe('connectSocketFresh', () => {
  it('waits out a socket path that exists before anyone listens on it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ttym-cf-'));
    const path = join(dir, 's.sock');
    bound = await bindOnly(path); // 파일은 있는데 듣는 이가 없다 → ECONNREFUSED
    setTimeout(() => { bound?.kill('SIGKILL'); bound = null; unlinkSync(path); server = createServer().listen(path); }, 150);
    const t0 = Date.now();
    const sock = await connectSocketFresh(path, Date.now() + 3000);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
    sock.destroy();
  });

  it('gives up at the deadline', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ttym-cf-'));
    const path = join(dir, 's.sock');
    bound = await bindOnly(path);
    await expect(connectSocketFresh(path, Date.now() + 200)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });
});
