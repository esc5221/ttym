import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import WebSocket from 'ws';
import { createServer, type TtymServer } from '../server.js';
import { classify, hostnameOf, normalizeHost, originAllowed } from './access.js';
import { RemoteStore } from './store.js';

// Raw http so Host / Origin / proxy headers can be set freely (fetch forbids Host).
function call(port: number, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: opts.headers }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function wsStatus(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    ws.once('open', () => { ws.close(); resolve(101); });
    ws.once('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 0); ws.terminate(); });
    ws.once('error', () => {});
  });
}

const fakeReq = (headers: Record<string, string>, remoteAddress = '127.0.0.1') =>
  ({ headers, socket: { remoteAddress } }) as never;

describe('access rules', () => {
  it('parses hostnames', () => {
    expect(hostnameOf('Example.com:443')).toBe('example.com');
    expect(hostnameOf('[::1]:7690')).toBe('::1');
    expect(hostnameOf('127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeHost('https://Box.tail1.ts.net/')).toBe('box.tail1.ts.net');
    expect(normalizeHost('a b')).toBeNull();
  });

  it('classifies local, tunnel, rebinding and LAN callers', () => {
    expect(classify(fakeReq({ host: '127.0.0.1:7690' })).remote).toBe(false);
    expect(classify(fakeReq({ host: 'localhost:7690' })).remote).toBe(false);
    // cloudflared / tailscale serve connect from loopback but carry the public name
    expect(classify(fakeReq({ host: 'ttym.example.com' })).reason).toBe('host');
    // a proxy that rewrote Host still leaves its own headers
    expect(classify(fakeReq({ host: '127.0.0.1:7690', 'cf-connecting-ip': '1.2.3.4' })).reason).toBe('proxy');
    // LAN peer claiming to be localhost
    expect(classify(fakeReq({ host: 'localhost' }, '192.168.0.9')).reason).toBe('peer');
  });

  it('accepts same-origin and loopback dev pages, refuses other sites', () => {
    const allow = new Set(['box.ts.net']);
    const local = (h: Record<string, string>) => originAllowed(fakeReq(h), classify(fakeReq(h)), allow);
    expect(local({ host: '127.0.0.1:7690' })).toBe(true); // CLI: no Origin
    expect(local({ host: '127.0.0.1:7690', origin: 'http://127.0.0.1:7690' })).toBe(true);
    expect(local({ host: '127.0.0.1:7690', origin: 'http://localhost:3300' })).toBe(true); // Vite dev
    expect(local({ host: '127.0.0.1:7690', origin: 'https://evil.example' })).toBe(false);
    expect(local({ host: '127.0.0.1:7690', origin: 'null' })).toBe(false);
    const remoteH = { host: 'box.ts.net', origin: 'http://localhost:3300' };
    expect(originAllowed(fakeReq(remoteH), classify(fakeReq(remoteH)), allow)).toBe(false);
  });
});

describe('remote store', () => {
  it('links are single-use and expire; sessions expire', () => {
    let now = 1_000;
    const dir = `/tmp/ttym-remote-store-${process.pid}`;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const store = new RemoteStore(`${dir}/remote.json`, () => now);
    const link = store.mintLink(null);
    const s = store.redeemLink(link.token, { host: 'h', userAgent: null });
    expect(s).not.toBeNull();
    expect(store.redeemLink(link.token, { host: 'h', userAgent: null })).toBeNull();
    expect(store.verify(s!.token)?.id).toBe(s!.session.id);
    expect(statSync(`${dir}/remote.json`).mode & 0o777).toBe(0o600);
    const late = store.mintLink(null);
    now += 11 * 60 * 1000;
    expect(store.redeemLink(late.token, { host: 'h', userAgent: null })).toBeNull();
    now += 31 * 24 * 60 * 60 * 1000;
    expect(store.verify(s!.token)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('server gate', () => {
  let server: TtymServer;
  let port: number;
  const home = `/tmp/ttym-remote-test-${process.pid}`;

  beforeAll(async () => {
    process.env.TTYM_RUNTIME_DIR = `${home}/run`;
    process.env.TTYM_HOME = home;
    server = await createServer(0);
    port = (server.httpServer.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.manager.destroyAll();
    await server.close();
    rmSync(home, { recursive: true, force: true });
    delete process.env.TTYM_RUNTIME_DIR;
    delete process.env.TTYM_HOME;
  });

  const JSON_H = { 'content-type': 'application/json' };

  it('local CLI calls pass without Origin, and no CORS header is sent', async () => {
    const r = await call(port, '/api/sessions', { headers: { host: `127.0.0.1:${port}` } });
    expect(r.status).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('refuses a cross-site write from the browser', async () => {
    const r = await call(port, '/api/config', { method: 'PATCH', headers: { host: `127.0.0.1:${port}`, origin: 'https://evil.example', ...JSON_H }, body: '{"values":{}}' });
    expect(r.status).toBe(403);
    const plain = await call(port, '/api/sessions/1/send', { method: 'POST', headers: { host: `127.0.0.1:${port}`, origin: 'https://evil.example', 'content-type': 'text/plain' }, body: '{"data":"x"}' });
    expect(plain.status).toBe(403);
  });

  it('refuses DNS rebinding (unknown Host)', async () => {
    const r = await call(port, '/api/sessions', { headers: { host: `evil.example:${port}` } });
    expect(r.status).toBe(403);
    expect(r.body).toContain('ttym remote allow-host');
  });

  it('refuses a cross-site WebSocket and accepts the CLI one', async () => {
    expect(await wsStatus(port, { origin: 'https://evil.example' })).toBe(403);
    expect(await wsStatus(port, {})).toBe(101);
  });

  it('remote: allow-host, login required, link → cookie → access, revoke', async () => {
    const tunnel = { host: 'ttym.example.com', 'x-forwarded-for': '203.0.113.9' };
    // /api/remote answers local callers only
    expect((await call(port, '/api/remote', { headers: tunnel })).status).toBe(403);
    const add = await call(port, '/api/remote/hosts', { method: 'POST', headers: { host: `127.0.0.1:${port}`, ...JSON_H }, body: '{"host":"https://TTYM.example.com/"}' });
    expect(JSON.parse(add.body)).toMatchObject({ host: 'ttym.example.com', changed: true });

    const page = await call(port, '/', { headers: { ...tunnel, accept: 'text/html' } });
    expect(page.status).toBe(401);
    expect(page.body).toContain('ttym remote link');
    expect((await call(port, '/api/sessions', { headers: tunnel })).status).toBe(401);
    expect(await wsStatus(port, { ...tunnel, origin: 'https://ttym.example.com' })).toBe(401);

    const link = JSON.parse((await call(port, '/api/remote/links', { method: 'POST', headers: { host: `127.0.0.1:${port}`, ...JSON_H }, body: '{}' })).body);
    const login = await call(port, '/api/auth/login', { method: 'POST', headers: { ...tunnel, origin: 'https://ttym.example.com', ...JSON_H }, body: JSON.stringify({ token: link.token }) });
    expect(login.status).toBe(200);
    const setCookie = String(login.headers['set-cookie']);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/Secure/);
    const cookie = setCookie.split(';')[0]!;

    expect((await call(port, '/api/sessions', { headers: { ...tunnel, cookie } })).status).toBe(200);
    expect(await wsStatus(port, { ...tunnel, origin: 'https://ttym.example.com', cookie })).toBe(101);
    // a second use of the same link fails
    expect((await call(port, '/api/auth/login', { method: 'POST', headers: { ...tunnel, ...JSON_H }, body: JSON.stringify({ token: link.token }) })).status).toBe(401);

    await call(port, '/api/remote/sessions/all', { method: 'DELETE', headers: { host: `127.0.0.1:${port}` } });
    expect((await call(port, '/api/sessions', { headers: { ...tunnel, cookie } })).status).toBe(401);
  });

  it('LAN peer pretending to be localhost is still remote', async () => {
    // Can't forge the peer address over loopback; the proxy header path covers the same rule.
    const r = await call(port, '/api/sessions', { headers: { host: `127.0.0.1:${port}`, 'cf-connecting-ip': '1.2.3.4' } });
    expect(r.status).toBe(403); // 127.0.0.1 is not an allow-listed remote host
  });
});
