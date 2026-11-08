import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:net';
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectSocketFresh } from './session.js';

// 소켓 파일은 bind()에서 생기고 listen()은 그 뒤 — 그 틈에 붙으면 ECONNREFUSED(2026-11-08 벤치·flaky 테스트).
let dir = '';
let server: Server | null = null;
afterEach(() => { server?.close(); server = null; if (dir) rmSync(dir, { recursive: true, force: true }); });

describe('connectSocketFresh', () => {
  it('waits out a socket path that exists before anyone listens on it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ttym-cf-'));
    const path = join(dir, 's.sock');
    writeFileSync(path, ''); // 파일은 있는데 듣는 이가 없다 → ECONNREFUSED
    setTimeout(() => { unlinkSync(path); server = createServer().listen(path); }, 150);
    const t0 = Date.now();
    const sock = await connectSocketFresh(path, Date.now() + 3000);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
    sock.destroy();
  });

  it('gives up at the deadline', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ttym-cf-'));
    const path = join(dir, 's.sock');
    writeFileSync(path, '');
    await expect(connectSocketFresh(path, Date.now() + 200)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });
});
