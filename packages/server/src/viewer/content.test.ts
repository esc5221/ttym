import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveFile } from './content.js';

// 2026-11-05 prod 재시작: 응답 도중 브라우저가 끊으면 serveFile이 끝나지 않아 FileHandle이
// 닫히지 않았고, GC가 그것을 거둘 때 Node 26이 ERR_INVALID_STATE로 서버를 죽였다.
let dir = '';
let server: Server;
let finished: Promise<void>;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ttym-content-')); });
afterEach(() => { server?.close(); try { rmSync(dir, { recursive: true }); } catch {} });

describe('serveFile', () => {
  it('finishes (and closes the file) when the client hangs up mid-response', async () => {
    const big = join(dir, 'big.html');
    writeFileSync(big, Buffer.alloc(64 << 20, 0x61)); // 소켓 버퍼보다 훨씬 크게 — 끊길 때 아직 보내는 중이어야 한다
    let resolveFinished!: () => void;
    finished = new Promise((r) => { resolveFinished = r; });
    server = createServer((req, res) => { void serveFile(req, res, big).then(resolveFinished); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;

    await new Promise<void>((r) => {
      const req = request({ host: '127.0.0.1', port, path: '/' }, (res) => {
        res.once('data', () => { req.destroy(); r(); }); // 첫 조각만 받고 끊는다
      });
      req.end();
    });

    const outcome = await Promise.race([
      finished.then(() => 'finished'),
      new Promise((r) => setTimeout(() => r('hung'), 2000)),
    ]);
    expect(outcome).toBe('finished');
  });

  it('still serves a whole file', async () => {
    const small = join(dir, 'a.html');
    writeFileSync(small, '<p>hi</p>');
    server = createServer((req, res) => { void serveFile(req, res, small); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    const body = await new Promise<string>((r) => {
      request({ host: '127.0.0.1', port, path: '/' }, (res) => {
        let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => r(s));
      }).end();
    });
    expect(body).toBe('<p>hi</p>');
  });
});
