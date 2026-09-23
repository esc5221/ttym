import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { rmSync } from 'node:fs';
import { createServer, type TtymServer } from './server.js';

// A missing holder binary used to throw an unhandled spawn 'error' and take the
// whole server down (found by the release smoke on a clean Linux runner).
describe('missing holder binary', () => {
  let server: TtymServer;
  let port: number;
  const home = `/tmp/ttym-holder-missing-${process.pid}`;

  beforeAll(async () => {
    process.env.TTYM_HOME = home;
    process.env.TTYM_RUNTIME_DIR = `${home}/run`;
    process.env.TTYM_HOLDER_BIN = `${home}/no-such-holder`;
    server = await createServer(0);
    port = (server.httpServer.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await server.close();
    rmSync(home, { recursive: true, force: true });
    delete process.env.TTYM_HOME; delete process.env.TTYM_RUNTIME_DIR; delete process.env.TTYM_HOLDER_BIN;
  });

  it('fails the request with the reason and keeps serving', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: ['/bin/sh'], cols: 80, rows: 24 }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await res.text()).toMatch(/holder/i);
    expect((await fetch(`http://127.0.0.1:${port}/api/version`)).status).toBe(200);
  });
});
