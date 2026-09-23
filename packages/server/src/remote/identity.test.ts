import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync, sign as cryptoSign, type JsonWebKey } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { resolveIdentity, verifyAccessJwt, isTailnetAddress, type IdentityDeps, type TrustConfig } from './identity.js';
import { RemoteStore } from './store.js';
import { gate, type RemoteContext } from './http.js';

const TEAM = 'acme';
const AUD = 'a'.repeat(64);
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK: JsonWebKey = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };

function jwt(payload: Record<string, unknown>, kid = 'k1'): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg: 'RS256', kid, typ: 'JWT' });
  const body = enc(payload);
  const sig = cryptoSign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
  return `${head}.${body}.${sig}`;
}
const NOW = 1_800_000_000_000;
const good = (over: Record<string, unknown> = {}) => jwt({ iss: `https://${TEAM}.cloudflareaccess.com`, aud: [AUD], email: 'me@example.com', exp: NOW / 1000 + 600, ...over });

const deps = (over: Partial<IdentityDeps> = {}): IdentityDeps => ({
  whois: async (ip) => (ip === '100.90.237.64' ? 'me@example.com' : ip === '100.90.0.2' ? 'other@example.com' : null),
  fetchCerts: async () => [JWK],
  now: () => NOW,
  ...over,
});
const trust: TrustConfig = { tailscale: { logins: ['me@example.com'] }, cloudflare: [{ team: TEAM, aud: AUD, emails: ['me@example.com'] }] };
const req = (headers: Record<string, string>) => ({ headers, socket: { remoteAddress: '127.0.0.1' } }) as never;

describe('tailscale identity', () => {
  const ts = (h: Record<string, string>) => resolveIdentity(req({ host: 'box.ts.net', ...h }), trust, deps());

  it('accepts the owner arriving through tailscale serve', async () => {
    expect(await ts({ 'tailscale-user-login': 'me@example.com', 'x-forwarded-for': '100.90.237.64' })).toEqual({ via: 'tailscale', who: 'me@example.com' });
  });
  it('refuses a login that is not trusted, even when whois agrees', async () => {
    expect(await ts({ 'tailscale-user-login': 'other@example.com', 'x-forwarded-for': '100.90.0.2' })).toBeNull();
  });
  it('refuses a forged header that came through a LAN proxy (last hop is not tailnet)', async () => {
    expect(await ts({ 'tailscale-user-login': 'me@example.com', 'x-forwarded-for': '100.90.237.64, 192.168.0.9' })).toBeNull();
  });
  it('refuses when whois names someone else', async () => {
    expect(await ts({ 'tailscale-user-login': 'me@example.com', 'x-forwarded-for': '100.90.0.2' })).toBeNull();
  });
  it('refuses the header through Cloudflare', async () => {
    expect(await ts({ 'tailscale-user-login': 'me@example.com', 'x-forwarded-for': '100.90.237.64', 'cf-connecting-ip': '1.2.3.4' })).toBeNull();
  });
  it('knows the tailnet ranges', () => {
    expect(isTailnetAddress('100.64.0.1')).toBe(true);
    expect(isTailnetAddress('100.127.255.1')).toBe(true);
    expect(isTailnetAddress('100.128.0.1')).toBe(false);
    expect(isTailnetAddress('fd7a:115c:a1e0::1')).toBe(true);
    expect(isTailnetAddress('192.168.0.1')).toBe(false);
  });
});

describe('cloudflare access jwt', () => {
  const entry = trust.cloudflare![0]!;
  it('accepts a valid token for an allowed email', async () => {
    expect(await verifyAccessJwt(good(), entry, deps())).toBe('me@example.com');
  });
  it('refuses wrong aud, wrong issuer, expired, other email', async () => {
    expect(await verifyAccessJwt(good({ aud: ['b'.repeat(64)] }), entry, deps())).toBeNull();
    expect(await verifyAccessJwt(good({ iss: 'https://evil.cloudflareaccess.com' }), entry, deps())).toBeNull();
    expect(await verifyAccessJwt(good({ exp: NOW / 1000 - 120 }), entry, deps())).toBeNull();
    expect(await verifyAccessJwt(good({ email: 'someone@else.com' }), entry, deps())).toBeNull();
  });
  it('refuses a tampered payload', async () => {
    const [h, , s] = good().split('.');
    const forged = Buffer.from(JSON.stringify({ iss: `https://${TEAM}.cloudflareaccess.com`, aud: [AUD], email: 'me@example.com', exp: NOW / 1000 + 9999 })).toString('base64url');
    expect(await verifyAccessJwt(`${h}.${forged}.${s}`, entry, deps())).toBeNull();
  });
  it('refetches keys once when the kid is new (rotation)', async () => {
    let calls = 0;
    const rotating = deps({ fetchCerts: async (_t, refresh) => { calls++; return refresh ? [{ ...JWK, kid: 'k2' }] : [JWK]; } });
    expect(await verifyAccessJwt(jwt({ iss: `https://${TEAM}.cloudflareaccess.com`, aud: AUD, email: 'me@example.com', exp: NOW / 1000 + 60 }, 'k2'), entry, rotating)).toBe('me@example.com');
    expect(calls).toBe(2);
  });
});

describe('gate with identity', () => {
  let srv: Server; let port: number;
  const dir = `/tmp/ttym-identity-${process.pid}`;
  beforeAll(async () => {
    rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
    const store = new RemoteStore(`${dir}/remote.json`);
    store.addHost('ttym.example.com'); store.addHost('box.ts.net');
    store.trustTailscale('me@example.com');
    store.trustCloudflare({ team: TEAM, aud: AUD, emails: ['me@example.com'] });
    const ctx: RemoteContext = { store, bindHost: '127.0.0.1', port: 0, log: () => {}, identity: deps({ now: () => Date.now() }) };
    srv = createServer((q, r) => {
      const g = gate(q, r, ctx);
      const route = () => { r.writeHead(200); r.end('app'); };
      if (g === 'pass') route(); else if (g !== 'handled') g.then((x) => x === 'pass' && route());
    });
    await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
    port = (srv.address() as AddressInfo).port;
  });
  afterAll(() => { srv.close(); rmSync(dir, { recursive: true, force: true }); });

  const get = (headers: Record<string, string>) => new Promise<{ status: number; cookie: string | undefined }>((ok) => {
    request({ host: '127.0.0.1', port, path: '/api/sessions', headers }, (res) => { res.resume(); ok({ status: res.statusCode!, cookie: res.headers['set-cookie']?.[0] }); }).end();
  });

  it('Access JWT → cookie issued, request passes; a bad JWT gets 401', async () => {
    const nowJwt = jwt({ iss: `https://${TEAM}.cloudflareaccess.com`, aud: [AUD], email: 'me@example.com', exp: Date.now() / 1000 + 600 });
    const ok = await get({ host: 'ttym.example.com', 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-proto': 'https', 'cf-access-jwt-assertion': nowJwt });
    expect(ok.status).toBe(200);
    expect(ok.cookie).toMatch(/ttym_session=.+HttpOnly.+Secure/);
    const bad = await get({ host: 'ttym.example.com', 'cf-connecting-ip': '1.2.3.4', 'cf-access-jwt-assertion': nowJwt.slice(0, -4) + 'AAAA' });
    expect(bad.status).toBe(401);
  });

  it('tailnet owner → passes; the same header through a LAN proxy → 401', async () => {
    expect((await get({ host: 'box.ts.net', 'tailscale-user-login': 'me@example.com', 'x-forwarded-for': '100.90.237.64' })).status).toBe(200);
    expect((await get({ host: 'box.ts.net', 'tailscale-user-login': 'me@example.com', 'x-forwarded-for': '192.168.0.9' })).status).toBe(401);
  });
});
