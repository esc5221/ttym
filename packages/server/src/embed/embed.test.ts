import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import WebSocket from 'ws';
import { request as httpRequest } from 'node:http';
import { CMD, checkGrantRequest, type EmbedConsumer } from '@ttym/protocol';
import { createServer, type TtymServer } from '../server.js';
import { decode, encode, toBuffer } from '../protocol.js';
import { INBOUND, authorizeInbound, filterOutbound } from './authorize.js';
import { sha256 } from './store.js';

const ORIGIN = 'https://app.example.test';

const consumer = (over: Partial<EmbedConsumer> = {}): EmbedConsumer => ({
  keyHash: sha256('k'), origins: [ORIGIN], workspaces: ['dock'], maxTtlMs: 3_600_000,
  profiles: { sh: { cmd: ['/bin/sh'], maxTabs: 3, keepOne: true } }, ...over,
});

describe('authorizeInbound / filterOutbound', () => {
  it('has a row for every CMD — a new command is refused until someone decides', () => {
    for (const [name, value] of Object.entries(CMD)) expect(INBOUND[value], `CMD.${name}`).toBeDefined();
  });

  it('reaches only the granted workspace, and input only with terminal.write', () => {
    const where = (sid: number) => (sid === 1 ? 'dock' : sid === 2 ? 'other' : undefined);
    const ro = [{ workspace: 'dock', caps: ['terminal.read' as const] }];
    const rw = [{ workspace: 'dock', caps: ['terminal.read' as const, 'terminal.write' as const] }];
    expect(authorizeInbound(ro, CMD.ATTACH, 1, where)).toBe(true);
    expect(authorizeInbound(ro, CMD.ATTACH, 2, where)).toBe(false);
    expect(authorizeInbound(ro, CMD.SNAPSHOT, 2, where)).toBe(false);
    expect(authorizeInbound(ro, CMD.RESUME_VIEW, 2, where)).toBe(false);
    expect(authorizeInbound(ro, CMD.DATA, 1, where)).toBe(false);
    expect(authorizeInbound(rw, CMD.DATA, 1, where)).toBe(true);
    expect(authorizeInbound(rw, CMD.RESIZE, 2, where)).toBe(false);
    for (const cmd of [CMD.CREATE, CMD.DESTROY, CMD.PAUSE, CMD.RESUME, 0x7f]) expect(authorizeInbound(rw, cmd, 1, where)).toBe(false);
  });

  it('a session grant follows the session, not its workspace', () => {
    const access = [{ session: 5, caps: ['terminal.read' as const] }];
    expect(authorizeInbound(access, CMD.ATTACH, 5, () => 'anywhere')).toBe(true);
    expect(authorizeInbound(access, CMD.ATTACH, 6, () => 'anywhere')).toBe(false);
  });

  it('pushes only the granted workspace; never AGENT, VIEW or CONFIG', () => {
    const access = [{ workspace: 'dock', caps: ['terminal.read' as const] }];
    expect(filterOutbound(access, CMD.WORKSPACE, { generation: 3, workspace: { id: 'dock' } })).toEqual({ generation: 3, workspace: { id: 'dock' } });
    expect(filterOutbound(access, CMD.WORKSPACE, { generation: 3, workspace: { id: 'other' } })).toBeNull();
    expect(filterOutbound(access, CMD.WORKSPACE, { generation: 3, order: ['dock', 'other'] })).toBeNull();
    expect(filterOutbound(access, CMD.WORKSPACE, { generation: 4, deletedId: 'dock' })).toEqual({ generation: 4, deletedId: 'dock' });
    for (const cmd of [CMD.AGENT, CMD.VIEW, CMD.CONFIG, 0x7f]) expect(filterOutbound(access, cmd, { sessionId: 1 })).toBeNull();
  });
});

describe('checkGrantRequest — outside the registration is an error, not a narrower grant', () => {
  const where = (sid: number) => (sid === 9 ? 'dock' : sid === 10 ? 'private' : undefined);
  const ok = (body: unknown) => checkGrantRequest(consumer(), body, where);

  it('accepts what was registered', () => {
    const r = ok({ subject: 'kim', ttlMs: 60_000, access: [{ workspace: 'dock', caps: ['terminal.read', 'terminal.write', 'tabs.write'], profile: 'sh' }] });
    expect(r.ok).toBe(true);
    expect(ok({ access: [{ session: 9, caps: ['terminal.read'] }] }).ok).toBe(true);
  });

  it.each([
    ['unregistered workspace', { access: [{ workspace: 'private', caps: ['terminal.read'] }] }],
    ['session outside the workspaces', { access: [{ session: 10, caps: ['terminal.read'] }] }],
    ['unknown capability', { access: [{ workspace: 'dock', caps: ['terminal.read', 'agent.drive'] }] }],
    ['write without read', { access: [{ workspace: 'dock', caps: ['terminal.write'] }] }],
    ['tabs.write without a profile', { access: [{ workspace: 'dock', caps: ['terminal.read', 'tabs.write'] }] }],
    ['unknown profile', { access: [{ workspace: 'dock', caps: ['terminal.read', 'tabs.write'], profile: 'root' }] }],
    ['a command in the request', { access: [{ workspace: 'dock', caps: ['terminal.read'], cmd: ['bash'] }] }],
    ['ttl past the ceiling', { ttlMs: 7_200_000, access: [{ workspace: 'dock', caps: ['terminal.read'] }] }],
    ['tabs on a session entry', { access: [{ session: 9, caps: ['terminal.read', 'tabs.write'] }] }],
    ['both workspace and session', { access: [{ workspace: 'dock', session: 9, caps: ['terminal.read'] }] }],
    ['no access', { access: [] }],
  ])('refuses %s', (_why, body) => {
    expect(ok(body).ok).toBe(false);
  });
});

// ── over the wire ──

type Frame = NonNullable<ReturnType<typeof decode>>;

class Client {
  frames: Frame[] = [];
  closed: { code: number; reason: string } | null = null;
  constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => { const f = decode(toBuffer(raw)); if (f) this.frames.push(f); });
    ws.on('close', (code, reason) => { this.closed = { code, reason: reason.toString() }; });
  }
  send(sid: number, cmd: number, body?: unknown) {
    this.ws.send(encode(sid, cmd, body === undefined ? undefined : Buffer.from(JSON.stringify(body))));
  }
  async next(pred: (f: Frame) => boolean, ms = 5000): Promise<Frame> {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const i = this.frames.findIndex(pred);
      if (i >= 0) return this.frames.splice(i, 1)[0]!;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('timed out waiting for frame');
  }
  async waitClosed(ms = 5000) {
    const start = Date.now();
    while (!this.closed && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 20));
    return this.closed;
  }
}

async function open(url: string, origin?: string): Promise<Client> {
  const ws = new WebSocket(url, origin ? { origin } : {});
  const c = new Client(ws);
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); ws.once('unexpected-response', (_q, r) => reject(new Error(`HTTP ${r.statusCode}`))); });
  return c;
}

const json = (f: Frame) => JSON.parse(Buffer.from(f.payload).toString());

describe('embed over the wire', () => {
  const home = `/tmp/ttym-embed-test-${process.pid}`;
  let server: TtymServer | null = null;
  let port = 0;
  const clients: Client[] = [];
  const KEY = 'test-consumer-key-0123456789';

  const api = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, init);
  /** The admin listener: a unix socket in the test home. */
  const admin = (method: string, path: string, headers: Record<string, string> = {}, body?: string, extra: Record<string, string> = {}) =>
    new Promise<{ status: number; body: any }>((done, fail) => {
      const req = httpRequest({ socketPath: `${home}/embed.sock`, method, path, headers: { ...headers, ...extra } }, (r) => {
        let data = ''; r.on('data', (c) => (data += c)); r.on('end', () => done({ status: r.statusCode ?? 0, body: data ? JSON.parse(data) : null }));
      });
      req.on('error', fail);
      req.end(body);
    });
  const mint = (access: unknown, ttlMs?: number) => admin('POST', '/api/embed/v1/grants',
    { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    JSON.stringify({ subject: 'kim', access, ...(ttlMs ? { ttlMs } : {}) }));
  const tabs = (grant: string, method = 'GET', path = '', body?: unknown) => api(`/api/embed/v1/workspaces/dock/tabs${path}`, {
    method, headers: { authorization: `Bearer ${grant}`, origin: ORIGIN, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const embedSocket = async (grant: string) => {
    const c = await open(`ws://127.0.0.1:${port}/embed/v1/ws`, ORIGIN);
    clients.push(c);
    c.send(0, CMD.HELLO, { grant });
    return c;
  };

  beforeEach(async () => {
    process.env.TTYM_RUNTIME_DIR = home;
    process.env.TTYM_HOME = home;
    mkdirSync(home, { recursive: true });
    writeFileSync(`${home}/embed-consumers.json`, JSON.stringify({
      app: { keyHash: sha256(KEY), origins: [ORIGIN], workspaces: ['dock'], maxTtlMs: 3_600_000, profiles: { sh: { cmd: ['/bin/sh'], maxTabs: 3, keepOne: true } } },
    }));
    server = await createServer(0);
    port = (server.httpServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) { try { c.ws.close(); } catch {} }
    if (server) { server.manager.destroyAll(); await server.close(); }
    server = null;
    await new Promise((r) => setTimeout(r, 150));
    try { rmSync(home, { recursive: true }); } catch {}
    delete process.env.TTYM_RUNTIME_DIR;
    delete process.env.TTYM_HOME;
  });

  it('the panel route serves only its own files — no absolute or escaping paths', async () => {
    const http = await import('node:http');
    const get = (path: string) => new Promise<number>((done) => {
      http.get({ host: '127.0.0.1', port, path }, (r) => { r.resume(); done(r.statusCode ?? 0); });
    });
    for (const p of ['/embed/v1//etc/hosts', '/embed/v1//etc/passwd', '/embed/v1/fonts//etc/hosts', '/embed/v1/%2Fetc%2Fhosts',
      '/embed/v1/..%2F..%2Fpackage.json', '/embed/v1/../../package.json', '/embed/v1/fonts/../../../package.json', '/embed/v1/\\etc\\hosts']) {
      expect([400, 404], p).toContain(await get(p));
    }
  });

  it('mints only with the consumer key, and only inside the registration', async () => {
    expect((await admin('POST', '/api/embed/v1/grants', {}, '{}')).status).toBe(401);
    // Never on the main port, whatever a proxy forwards.
    const onMain = await api('/api/embed/v1/grants', { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ access: [{ workspace: 'dock', caps: ['terminal.read'] }] }) });
    expect(onMain.status).toBe(404);
    expect((await onMain.json()).code).toBe('admin_listener');
    // And the admin listener answers nothing else.
    expect((await admin('GET', '/api/version')).status).toBe(404);
    expect((await admin('GET', '/api/embed/v1/grant')).status).toBe(404);
    expect((await mint([{ workspace: 'other', caps: ['terminal.read'] }])).status).toBe(400);
    const ok = await mint([{ workspace: 'dock', caps: ['terminal.read', 'terminal.write', 'tabs.write'], profile: 'sh' }]);
    expect(ok.status).toBe(201);
    expect(ok.body.grant).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const version = await (await api('/api/version')).json();
    expect(version.embed).toEqual({ api: 1, sdk: 1 });
  });

  it('a grant connection reaches its workspace and nothing else', async () => {
    // A session outside the grant, made the ordinary way.
    const outside = await (await api('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd: ['/bin/sh'] }) })).json();
    const { body: g } = await mint([{ workspace: 'dock', caps: ['terminal.read', 'terminal.write', 'tabs.write'], profile: 'sh' }]);
    const list = await (await tabs(g.grant)).json();
    expect(list.tabs).toHaveLength(1); // keepOne opened the first tab
    const mine = list.tabs[0].sid;

    const c = await embedSocket(g.grant);
    c.send(0, CMD.LIST);
    const listed = json(await c.next((f) => f.cmd === CMD.LIST)).map((s: { id: number }) => s.id);
    expect(listed).toEqual([mine]);

    c.send(outside.id, CMD.ATTACH, { fromSeq: 0 });
    expect(json(await c.next((f) => f.cmd === CMD.ATTACH && f.sessionId === outside.id)).ok).toBe(false);
    c.send(mine, CMD.ATTACH, { fromSeq: 0 });
    expect(json(await c.next((f) => f.cmd === CMD.ATTACH && f.sessionId === mine)).ok).toBe(true);

    // Input to the outside session is dropped; to its own reaches the shell.
    c.send(outside.id, CMD.DATA, undefined);
    c.ws.send(encode(outside.id, CMD.DATA, Buffer.from('echo LEAK\n')));
    c.ws.send(encode(mine, CMD.DATA, Buffer.from('echo HELLO_EMBED\n')));
    await new Promise((r) => setTimeout(r, 600));
    const screen = (id: number) => api(`/api/sessions/${id}/screen?format=text`).then((r) => r.json()).then((j) => j.screen as string);
    expect(await screen(mine)).toContain('HELLO_EMBED');
    expect(await screen(outside.id)).not.toContain('LEAK');

    // A workspace change elsewhere is not pushed; config is never pushed.
    await api('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'private', name: 'private', layout: { type: 'pane', sessionId: outside.id }, members: [{ sessionId: outside.id, name: 'x' }] }) });
    await api('/api/config', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ 'font-size': '13' }) });
    await new Promise((r) => setTimeout(r, 300));
    expect(c.frames.some((f) => f.cmd === CMD.CONFIG || f.cmd === CMD.VIEW || f.cmd === CMD.AGENT)).toBe(false);
    expect(c.frames.filter((f) => f.cmd === CMD.WORKSPACE).map((f) => json(f).workspace?.id)).not.toContain('private');
  });

  it('read-only grants attach read-only and cannot change tabs', async () => {
    const { body: rw } = await mint([{ workspace: 'dock', caps: ['terminal.read', 'terminal.write', 'tabs.write'], profile: 'sh' }]);
    const sid = (await (await tabs(rw.grant)).json()).tabs[0].sid;
    const { body: ro } = await mint([{ workspace: 'dock', caps: ['terminal.read'] }]);
    expect((await tabs(ro.grant, 'POST', '', {})).status).toBe(403);
    const c = await embedSocket(ro.grant);
    c.send(sid, CMD.ATTACH, { fromSeq: 0, cols: 50, rows: 10 });
    expect(json(await c.next((f) => f.cmd === CMD.ATTACH)).ok).toBe(true);
    c.ws.send(encode(sid, CMD.DATA, Buffer.from('echo NOPE\n')));
    await new Promise((r) => setTimeout(r, 500));
    const info = await (await api(`/api/sessions/${sid}`)).json();
    expect(info.cols).not.toBe(50); // a read-only attach does not resize
    expect((await (await api(`/api/sessions/${sid}/screen?format=text`)).json()).screen).not.toContain('NOPE');
  });

  it('the socket needs the grant first; revoking closes it with 4401', async () => {
    const bare = await open(`ws://127.0.0.1:${port}/embed/v1/ws`, ORIGIN);
    clients.push(bare);
    bare.send(0, CMD.LIST);
    expect((await bare.waitClosed())?.code).toBe(4401);

    await expect(open(`ws://127.0.0.1:${port}/embed/v1/ws`, 'https://evil.example')).rejects.toThrow(/403/);

    const { body: g } = await mint([{ workspace: 'dock', caps: ['terminal.read'] }]);
    const c = await embedSocket(g.grant);
    c.send(0, CMD.LIST);
    await c.next((f) => f.cmd === CMD.LIST);
    const del = await admin('DELETE', `/api/embed/v1/grants/${g.id}`, { authorization: `Bearer ${KEY}` });
    expect(del.status).toBe(200);
    expect((await c.waitClosed())?.code).toBe(4401);
    expect((await tabs(g.grant)).status).toBe(401);
  });

  it('every command aimed at a session outside the grant leaves that session untouched', async () => {
    const outside = await (await api('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd: ['/bin/sh'], cols: 80, rows: 24 }) })).json();
    const { body: g } = await mint([{ workspace: 'dock', caps: ['terminal.read', 'terminal.write', 'tabs.write'], profile: 'sh' }]);
    await tabs(g.grant);
    const c = await embedSocket(g.grant);
    c.send(0, CMD.LIST);
    await c.next((f) => f.cmd === CMD.LIST);
    for (const value of Object.values(CMD)) {
      if (value === CMD.HELLO || value === CMD.LIST) continue;
      const payload = value === CMD.DATA ? Buffer.from('echo PWNED\n')
        : value === CMD.RESIZE ? Buffer.from([10, 0, 5, 0])
        : Buffer.from(JSON.stringify({ fromSeq: 0, seq: 1, cmd: ['/bin/sh'], cols: 10, rows: 5 }));
      c.ws.send(encode(outside.id, value, payload));
    }
    await new Promise((r) => setTimeout(r, 600));
    const info = await (await api(`/api/sessions/${outside.id}`)).json();
    expect(info.cols).toBe(80); // not resized
    const screen = (await (await api(`/api/sessions/${outside.id}/screen?format=text`)).json()).screen;
    expect(screen).not.toContain('PWNED');
    // still alive and not stopped: it runs a command we send the ordinary way
    await api(`/api/sessions/${outside.id}/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: 'echo ALIVE\n' }) });
    await new Promise((r) => setTimeout(r, 500));
    expect((await (await api(`/api/sessions/${outside.id}/screen?format=text`)).json()).screen).toContain('ALIVE');
    // nothing of that session came down the grant socket
    expect(c.frames.some((f) => f.sessionId === outside.id && f.cmd !== CMD.ATTACH)).toBe(false);
    expect(c.closed).toBeNull();
  });

  it('a frame before HELLO, or a grant from another consumer\'s origin, closes the socket', async () => {
    const outside = await (await api('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd: ['/bin/sh'] }) })).json();
    const early = await open(`ws://127.0.0.1:${port}/embed/v1/ws`, ORIGIN);
    clients.push(early);
    early.ws.send(encode(outside.id, CMD.DATA, Buffer.from('echo EARLY\n')));
    expect((await early.waitClosed())?.code).toBe(4401);
    await new Promise((r) => setTimeout(r, 300));
    expect((await (await api(`/api/sessions/${outside.id}/screen?format=text`)).json()).screen).not.toContain('EARLY');

    // A second consumer on another origin: app's grant over that origin is refused.
    writeFileSync(`${home}/embed-consumers.json`, JSON.stringify({
      app: { keyHash: sha256(KEY), origins: [ORIGIN], workspaces: ['dock'], maxTtlMs: 3_600_000, profiles: { sh: { cmd: ['/bin/sh'], maxTabs: 3, keepOne: true } } },
      other: { keyHash: sha256('other-key-0123456789abcdef'), origins: ['https://other.example.test'], workspaces: ['elsewhere'], maxTtlMs: 3_600_000, profiles: {} },
    }));
    const { body: g } = await mint([{ workspace: 'dock', caps: ['terminal.read'] }]);
    const cross = await open(`ws://127.0.0.1:${port}/embed/v1/ws`, 'https://other.example.test');
    clients.push(cross);
    cross.send(0, CMD.HELLO, { grant: g.grant });
    expect((await cross.waitClosed())?.code).toBe(4401);
    // And over HTTP.
    const r = await api('/api/embed/v1/workspaces/dock/tabs', { method: 'POST', headers: { authorization: `Bearer ${g.grant}`, origin: 'https://other.example.test', 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(403);
  });

  it('rotating the key ends its grants — an idle socket too — and the old grant stays dead', async () => {
    const { body: g } = await mint([{ workspace: 'dock', caps: ['terminal.read'] }]);
    const c = await embedSocket(g.grant);
    c.send(0, CMD.LIST);
    await c.next((f) => f.cmd === CMD.LIST);
    writeFileSync(`${home}/embed-consumers.json`, JSON.stringify({
      app: { keyHash: sha256('rotated-key-0123456789abcdef'), origins: [ORIGIN], workspaces: ['dock'], maxTtlMs: 3_600_000, profiles: {} },
    }));
    // No frame from the client: the sweep has to notice.
    expect((await c.waitClosed(8000))?.code).toBe(4401);
    expect((await tabs(g.grant)).status).toBe(401);
    const again = await embedSocket(g.grant);
    expect((await again.waitClosed())?.code).toBe(4401);
  }, 15_000);

  it('a grant past its expiry is refused on reconnect', async () => {
    const { body: g } = await mint([{ workspace: 'dock', caps: ['terminal.read'] }], 10_000);
    const c = await embedSocket(g.grant);
    c.send(0, CMD.LIST);
    await c.next((f) => f.cmd === CMD.LIST);
    expect((await c.waitClosed(12_000))?.code).toBe(4401);
    const again = await embedSocket(g.grant);
    expect((await again.waitClosed())?.code).toBe(4401);
    expect((await tabs(g.grant)).status).toBe(401);
  }, 20_000);

  it('closing a tab ends its shell and drops it from open grant sockets', async () => {
    const { body: g } = await mint([{ workspace: 'dock', caps: ['terminal.read', 'terminal.write', 'tabs.write'], profile: 'sh' }]);
    const first = (await (await tabs(g.grant)).json()).tabs[0].sid;
    const created = await (await tabs(g.grant, 'POST', '', { name: 'two' })).json();
    expect(created.tabs.map((t: { name: string }) => t.name)).toEqual(['sh', 'two']);
    const c = await embedSocket(g.grant);
    c.send(first, CMD.ATTACH, { fromSeq: 0 });
    await c.next((f) => f.cmd === CMD.ATTACH);
    const after = await (await tabs(g.grant, 'DELETE', `/${first}`)).json();
    expect(after.tabs.map((t: { sid: number }) => t.sid)).toEqual([created.tab.sid]);
    await c.next((f) => f.cmd === CMD.DESTROY && f.sessionId === first);
    c.send(first, CMD.ATTACH, { fromSeq: 0 });
    expect(json(await c.next((f) => f.cmd === CMD.ATTACH && f.sessionId === first)).ok).toBe(false);
    expect((await tabs(g.grant, 'PATCH', `/${created.tab.sid}`, { name: 'bad name' })).status).toBe(400);
    // The ordinary app socket still sees everything — the filter is for grant sockets only.
    const app = await open(`ws://127.0.0.1:${port}/ws`);
    clients.push(app);
    app.send(0, CMD.LIST);
    expect(json(await app.next((f) => f.cmd === CMD.LIST)).length).toBeGreaterThanOrEqual(1);
  });
});
