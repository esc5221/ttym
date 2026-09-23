/**
 * The front door: every HTTP request and WebSocket upgrade passes `gate`
 * before any handler sees it.
 *
 *   local  (CLI, hooks, localhost UI)  → Origin check on writes, nothing else
 *   remote (tunnel, tailnet, LAN)      → allow-listed Host + login cookie
 *
 * Login is a one-time link minted on the machine (`ttym remote link`): the
 * token rides in the URL fragment so link previews and proxies never see it,
 * the /auth page POSTs it back, and the answer is an HttpOnly cookie.
 * /api/remote/* configures all of this and answers local callers only.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { classify, hostAllowed, originAllowed, parseCookies, normalizeHost, viaHttps } from './access.js';
import type { RemoteStore } from './store.js';
import { SESSION_TTL_MS } from './store.js';
import { resolveIdentity, mayCarryIdentity, defaultIdentityDeps, type IdentityDeps } from './identity.js';

export const COOKIE = 'ttym_session';

export interface RemoteContext {
  store: RemoteStore;
  /** Interface the server listens on (TTYM_BIND). Reported by status/doctor. */
  bindHost: string;
  port: number;
  log: (...args: unknown[]) => void;
  /** Tests swap in fakes for tailscale whois and the Access key fetch. */
  identity?: IdentityDeps;
}

export type GateResult = 'pass' | 'handled';

/** 401s are logged, but one line per host and reason per minute — a reconnecting tab retries every second. */
const lastDenyLog = new Map<string, { at: number; count: number }>();
function logDenied(ctx: RemoteContext, key: string, line: string) {
  const now = Date.now();
  const e = lastDenyLog.get(key);
  if (e && now - e.at < 60_000) { e.count++; return; }
  const extra = e && e.count ? ` (+${e.count} more in the last minute)` : '';
  lastDenyLog.set(key, { at: now, count: 0 });
  ctx.log(`${line}${extra}`);
}

const identityDetail = (req: IncomingMessage) =>
  req.headers['cf-access-jwt-assertion'] ? 'access-jwt' : req.headers['tailscale-user-login'] ? `tailscale:${req.headers['tailscale-user-login']}` : 'no-identity';

type Json = (status: number, body: unknown, headers?: Record<string, string>) => void;

function sendJson(res: ServerResponse): Json {
  return (status, body, headers = {}) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'Cache-Control': 'no-store', ...headers });
    res.end(payload);
  };
}

function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > limit) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const isWrite = (method: string | undefined) => !!method && !['GET', 'HEAD', 'OPTIONS'].includes(method);

/** Secure only when the browser side is HTTPS (see viaHttps); over plain HTTP a Secure cookie is dropped. */
function cookieHeader(value: string, req: IncomingMessage, maxAgeSec: number): string {
  const secure = viaHttps(req) ? '; Secure' : '';
  return `${COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${secure}`;
}

function wantsHtml(req: IncomingMessage): boolean {
  return req.method === 'GET' && /text\/html/.test(req.headers.accept ?? '');
}

/**
 * 'handled' when the request was answered (refused, or an auth/remote route);
 * 'pass' when the normal handlers should take it. A promise only when a remote
 * request without a cookie carries an identity worth checking.
 */
export function gate(req: IncomingMessage, res: ServerResponse, ctx: RemoteContext): GateResult | Promise<GateResult> {
  const r = gateInner(req, res, ctx);
  return typeof r === 'boolean' ? (r ? 'handled' : 'pass') : r;
}

function gateInner(req: IncomingMessage, res: ServerResponse, ctx: RemoteContext): boolean | Promise<GateResult> {
  const caller = classify(req, ctx.store.allowHosts);
  const path = (req.url || '/').split('?')[0]!;
  const allow = ctx.store.allowHosts;

  if (!hostAllowed(caller, allow)) {
    ctx.log(`REMOTE refuse host=${caller.hostname} reason=${caller.reason} ${req.method} ${path}`);
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`host not allowed: ${caller.hostname ?? '(none)'}\non the ttym machine: ttym remote allow-host ${caller.hostname ?? '<host>'}\n`);
    return true;
  }
  if (isWrite(req.method) && !originAllowed(req)) {
    ctx.log(`REMOTE refuse origin=${req.headers.origin} ${req.method} ${path}`);
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('forbidden origin\n');
    return true;
  }

  if (path === '/auth' && req.method === 'GET') { authPage(res); return true; }
  if (path === '/api/auth/login' && req.method === 'POST') { login(req, res, caller, ctx); return true; }
  if (path === '/api/auth/logout' && req.method === 'POST') {
    const t = parseCookies(req.headers.cookie).get(COOKIE);
    if (t) ctx.store.revokeToken(t);
    sendJson(res)(200, { ok: true }, { 'Set-Cookie': cookieHeader('', req, 0) });
    return true;
  }

  if (path === '/api/remote' || path.startsWith('/api/remote/')) {
    if (caller.remote) { sendJson(res)(403, { error: 'local only' }); return true; }
    remoteApi(req, res, path, ctx);
    return true;
  }

  if (!caller.remote) return false;
  // Viewer content carries its own 128-bit capability in the path, and a
  // sandboxed iframe may not send our cookie.
  if (path.startsWith('/view/')) return false;
  const session = ctx.store.verify(parseCookies(req.headers.cookie).get(COOKIE));
  if (session) return false;

  const deny = (): GateResult => {
    logDenied(ctx, `${caller.hostname}|${identityDetail(req)}`, `REMOTE login required host=${caller.hostname} ${identityDetail(req)} ${req.method} ${path}`);
    if (wantsHtml(req)) loginRequiredPage(res);
    else sendJson(res)(401, { error: 'login required', hint: 'on the ttym machine: ttym remote link' });
    return 'handled';
  };
  if (!mayCarryIdentity(req, ctx.store.trust)) { deny(); return true; }
  return resolveIdentity(req, ctx.store.trust, ctx.identity ?? defaultIdentityDeps).then((id) => {
    if (!id) return deny();
    const out = ctx.store.issueSession({ host: caller.hostname, userAgent: req.headers['user-agent'] ?? null, via: `${id.via}:${id.who}` });
    ctx.log(`REMOTE login session=${out.session.id} host=${caller.hostname} via=${id.via}:${id.who}`);
    res.setHeader('Set-Cookie', cookieHeader(out.token, req, SESSION_TTL_MS / 1000));
    return 'pass' as GateResult;
  }, () => deny());
}

/** Same decision for a WebSocket upgrade. Resolves null to accept, or [code, message]. */
export async function gateUpgrade(req: IncomingMessage, ctx: RemoteContext): Promise<[number, string] | null> {
  const caller = classify(req, ctx.store.allowHosts);
  const allow = ctx.store.allowHosts;
  if (!hostAllowed(caller, allow)) return [403, 'host not allowed'];
  // Browsers always send Origin on a WebSocket handshake; a cross-site page is refused here.
  if (!originAllowed(req)) {
    ctx.log(`REMOTE refuse ws origin=${req.headers.origin}`);
    return [403, 'forbidden origin'];
  }
  if (!caller.remote) return null;
  if (ctx.store.verify(parseCookies(req.headers.cookie).get(COOKIE))) return null;
  // The page load before it normally set the cookie already; this covers a socket opened without one.
  if (mayCarryIdentity(req, ctx.store.trust) && await resolveIdentity(req, ctx.store.trust, ctx.identity ?? defaultIdentityDeps).catch(() => null)) return null;
  logDenied(ctx, `${caller.hostname}|ws|${identityDetail(req)}`, `REMOTE login required host=${caller.hostname} ${identityDetail(req)} WS`);
  return [401, 'login required'];
}

function login(req: IncomingMessage, res: ServerResponse, caller: ReturnType<typeof classify>, ctx: RemoteContext) {
  const json = sendJson(res);
  readBody(req).then((body) => {
    let linkToken: unknown;
    try { linkToken = JSON.parse(body).token; } catch {}
    if (typeof linkToken !== 'string' || !linkToken) { json(400, { error: 'token required' }); return; }
    const out = ctx.store.redeemLink(linkToken, { host: caller.hostname, userAgent: req.headers['user-agent'] ?? null });
    if (!out) {
      ctx.log(`REMOTE login rejected host=${caller.hostname}`);
      json(401, { error: 'link expired or already used' });
      return;
    }
    ctx.log(`REMOTE login session=${out.session.id} host=${caller.hostname}`);
    json(200, { ok: true, session: out.session.id }, { 'Set-Cookie': cookieHeader(out.token, req, SESSION_TTL_MS / 1000) });
  }).catch(() => json(400, { error: 'invalid body' }));
}

function remoteApi(req: IncomingMessage, res: ServerResponse, path: string, ctx: RemoteContext) {
  const json = sendJson(res);
  const { store } = ctx;
  if (path === '/api/remote' && req.method === 'GET') {
    json(200, { bindHost: ctx.bindHost, port: ctx.port, allowHosts: [...store.allowHosts].sort(), sessions: store.list().length, trust: store.trust });
    return;
  }
  if (path === '/api/remote/trust' && req.method === 'POST') {
    readBody(req).then((body) => {
      let b: { kind?: string; login?: string; team?: string; aud?: string; emails?: unknown };
      try { b = JSON.parse(body); } catch { json(400, { error: 'invalid body' }); return; }
      if (b.kind === 'tailscale' && typeof b.login === 'string' && b.login.includes('@')) {
        const changed = store.trustTailscale(b.login);
        ctx.log(`REMOTE trust tailscale ${b.login}`);
        json(200, { changed, trust: store.trust });
        return;
      }
      const emails = Array.isArray(b.emails) ? b.emails.filter((e): e is string => typeof e === 'string' && e.includes('@')) : [];
      if (b.kind === 'cloudflare' && typeof b.team === 'string' && /^[a-z0-9-]+$/i.test(b.team) && typeof b.aud === 'string' && /^[a-f0-9]{16,}$/i.test(b.aud) && emails.length) {
        const changed = store.trustCloudflare({ team: b.team.toLowerCase(), aud: b.aud.toLowerCase(), emails });
        ctx.log(`REMOTE trust cloudflare team=${b.team} aud=${b.aud.slice(0, 8)} ${emails.join(',')}`);
        json(200, { changed, trust: store.trust });
        return;
      }
      json(400, { error: 'want {kind:"tailscale", login} or {kind:"cloudflare", team, aud, emails:[…]}' });
    }).catch(() => json(400, { error: 'invalid body' }));
    return;
  }
  const trustMatch = path.match(/^\/api\/remote\/trust\/(tailscale|cloudflare|all)$/);
  if (trustMatch && req.method === 'DELETE') {
    store.untrust(trustMatch[1] as 'tailscale' | 'cloudflare' | 'all');
    json(200, { trust: store.trust });
    return;
  }
  if (path === '/api/remote/hosts' && req.method === 'POST') {
    readBody(req).then((body) => {
      let raw: unknown;
      try { raw = JSON.parse(body).host; } catch {}
      const host = typeof raw === 'string' ? normalizeHost(raw) : null;
      if (!host) { json(400, { error: 'host required' }); return; }
      const added = store.addHost(host);
      ctx.log(`REMOTE allow-host ${host}${added ? '' : ' (already)'}`);
      json(200, { host, changed: added, allowHosts: [...store.allowHosts].sort() });
    }).catch(() => json(400, { error: 'invalid body' }));
    return;
  }
  const hostMatch = path.match(/^\/api\/remote\/hosts\/([^/]+)$/);
  if (hostMatch && req.method === 'DELETE') {
    const host = normalizeHost(decodeURIComponent(hostMatch[1]!));
    const removed = !!host && store.removeHost(host);
    json(200, { host, changed: removed, allowHosts: [...store.allowHosts].sort() });
    return;
  }
  if (path === '/api/remote/links' && req.method === 'POST') {
    readBody(req).then((body) => {
      let raw: unknown;
      try { raw = JSON.parse(body || '{}').host; } catch {}
      const host = typeof raw === 'string' ? normalizeHost(raw) : null;
      json(200, store.mintLink(host));
    }).catch(() => json(400, { error: 'invalid body' }));
    return;
  }
  if (path === '/api/remote/sessions' && req.method === 'GET') { json(200, { sessions: store.list() }); return; }
  const sessMatch = path.match(/^\/api\/remote\/sessions\/([^/]+)$/);
  if (sessMatch && req.method === 'DELETE') {
    const n = store.revoke(decodeURIComponent(sessMatch[1]!));
    ctx.log(`REMOTE revoke ${sessMatch[1]} (${n})`);
    json(200, { revoked: n });
    return;
  }
  json(404, { error: 'not found' });
}

const PAGE_STYLE = `
  :root { color-scheme: light dark; --bg: #f7f7f6; --ink: #1d1d1f; --dim: #6b6b72; --line: #e2e2e5; --accent: #d9772b; }
  @media (prefers-color-scheme: dark) { :root { --bg: #161618; --ink: #ececef; --dim: #9a9aa2; --line: #2c2c31; --accent: #f29c5c; } }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--bg); color: var(--ink);
    font: 16px/1.6 -apple-system, system-ui, sans-serif; padding: 16px; box-sizing: border-box; }
  main { max-width: 420px; }
  h1 { font: 600 22px ui-monospace, Menlo, monospace; margin: 0 0 12px; }
  h1 span { color: var(--accent); }
  p { margin: 8px 0; color: var(--dim); }
  code { font: 14px ui-monospace, Menlo, monospace; color: var(--ink); background: color-mix(in srgb, var(--line) 60%, transparent); padding: 2px 6px; border-radius: 5px; }
`;

function page(res: ServerResponse, status: number, body: string, script = '') {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>ttym · login</title><style>${PAGE_STYLE}</style></head>
<body><main>${body}</main>${script ? `<script>${script}</script>` : ''}</body></html>`;
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  res.end(html);
}

function loginRequiredPage(res: ServerResponse) {
  page(res, 401, `<h1>ttym<span>_</span></h1>
<p>This ttym server needs a login link.</p>
<p>On the machine running ttym:</p>
<p><code>ttym remote link</code></p>
<p>then open the link it prints (or scan its QR code) on this device.</p>`);
}

function authPage(res: ServerResponse) {
  page(res, 200, `<h1>ttym<span>_</span></h1><p id="m">Signing in…</p>`, `
(async () => {
  const m = document.getElementById('m');
  const t = new URLSearchParams(location.hash.slice(1)).get('t');
  history.replaceState(null, '', '/auth');
  if (!t) { m.textContent = 'This link has no token. Run ttym remote link on the ttym machine.'; return; }
  try {
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: t }), credentials: 'same-origin' });
    if (r.ok) { location.replace('/'); return; }
    m.textContent = r.status === 401 ? 'This link expired or was already used. Run ttym remote link again.' : 'Sign-in failed (' + r.status + ').';
  } catch { m.textContent = 'Could not reach the server.'; }
})();`);
}
