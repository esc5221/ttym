/**
 * Who is asking: this machine, or someone through a tunnel / tailnet / LAN.
 *
 * The API has no auth of its own for local callers (CLI, hooks, the web UI on
 * localhost) and must stay that way — hooks fire on every agent turn. What it
 * must refuse:
 *   - a page on another site driving the local API from the user's browser
 *     (the Origin check),
 *   - DNS rebinding, where evil.example resolves to 127.0.0.1 and the browser
 *     calls it same-origin (the Host check),
 *   - anyone arriving from outside without a login (remote ⇒ cookie).
 *
 * "Remote" cannot be read off the socket alone: cloudflared and `tailscale
 * serve` both connect from 127.0.0.1. They do forward the public hostname as
 * Host and add proxy headers, so any one of three signals marks a request
 * remote: a non-loopback peer, a non-loopback Host, or a proxy header.
 */
import type { IncomingMessage } from 'node:http';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

/** Headers a reverse proxy in front of us adds. Their presence alone means "not this machine". */
const PROXY_HEADERS = [
  'cf-connecting-ip', 'cf-ray', 'x-forwarded-for', 'x-forwarded-host',
  'x-forwarded-proto', 'forwarded', 'x-real-ip', 'tailscale-user-login',
];

export interface Caller {
  remote: boolean;
  /** Host header hostname, lowercased, brackets and port stripped. */
  hostname: string | null;
  /** Why it counted as remote (or, for `local-proxy`, as local) — logged on refusals. */
  reason: 'local' | 'local-proxy' | 'peer' | 'host' | 'proxy';
}

/** Headers only an internet-facing proxy adds: never "this machine", whatever the addresses say. */
const EDGE_HEADERS = ['cf-connecting-ip', 'cf-ray', 'tailscale-user-login'];

/**
 * Client addresses a proxy reported: every X-Forwarded-For hop, X-Real-IP,
 * and Forwarded for=. nginx's $proxy_add_x_forwarded_for appends the real
 * peer to whatever the client sent, so a spoofed "127.0.0.1" from the LAN
 * still leaves the LAN address at the end of the list.
 */
function forwardedClients(req: IncomingMessage): string[] {
  const out: string[] = [];
  const xff = req.headers['x-forwarded-for'];
  for (const part of (Array.isArray(xff) ? xff.join(',') : xff ?? '').split(',')) if (part.trim()) out.push(part.trim());
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real.trim()) out.push(real.trim());
  const fwd = req.headers.forwarded;
  if (typeof fwd === 'string') for (const m of fwd.matchAll(/for="?\[?([^\]";,]+)/gi)) out.push(m[1]!);
  return out;
}

export function hostnameOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end > 0 ? h.slice(1, end) : null;
  }
  // A bare IPv6 literal without brackets is not a valid Host; treat the whole thing as the name.
  const colons = h.split(':').length - 1;
  if (colons === 1) return h.slice(0, h.indexOf(':'));
  return h || null;
}

export function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr === '::1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.');
}

export const isLoopbackHostname = (h: string | null) => !!h && LOOPBACK_HOSTNAMES.has(h);

/**
 * `allowHosts` enables one more local case: a reverse proxy on this machine
 * (nginx serving ttym.lullu.lan) relaying a browser that is also on this
 * machine. It counts as local only when the Host is allow-listed (so DNS
 * rebinding still cannot use it), no internet-edge header is present, and
 * every client address the proxy reported is loopback. A proxy that reports
 * nothing stays remote — there is no way to tell.
 */
export function classify(req: IncomingMessage, allowHosts: ReadonlySet<string> = new Set()): Caller {
  const peerLoopback = isLoopbackAddress(req.socket.remoteAddress);
  const hostname = hostnameOf(req.headers.host);
  const base = { hostname };
  if (!peerLoopback) return { ...base, remote: true, reason: 'peer' };
  const proxied = PROXY_HEADERS.some((h) => req.headers[h] !== undefined);
  if (isLoopbackHostname(hostname)) {
    return proxied ? { ...base, remote: true, reason: 'proxy' } : { ...base, remote: false, reason: 'local' };
  }
  if (hostname && allowHosts.has(hostname) && !EDGE_HEADERS.some((h) => req.headers[h] !== undefined)) {
    const clients = forwardedClients(req);
    if (clients.length && clients.every((a) => isLoopbackAddress(a) || isLoopbackHostname(a))) {
      return { ...base, remote: false, reason: 'local-proxy' };
    }
  }
  return { ...base, remote: true, reason: 'host' };
}

/** Local callers name a loopback host (or, via a local proxy, an allow-listed one); remote ones need an allow-listed name. */
export function hostAllowed(caller: Caller, allowHosts: ReadonlySet<string>): boolean {
  if (caller.reason === 'local') return true;
  return !!caller.hostname && allowHosts.has(caller.hostname);
}

/**
 * No Origin: not a browser (CLI, curl, hooks) — pass.
 * `null`: sandboxed viewer iframe — refuse.
 * Otherwise the page must be ours: its origin names the same host the request
 * was sent to. Every way the UI is served (the server, a tunnel, `tailscale
 * serve`, nginx, the Vite dev proxy) keeps the two equal, so another local
 * port — some other dev server — gets no exemption.
 */
export function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (origin === 'null') return false;
  let url: URL;
  try { url = new URL(origin); } catch { return false; }
  return !!req.headers.host && url.host.toLowerCase() === req.headers.host.toLowerCase();
}

/**
 * Did the browser reach us over HTTPS? Only a proxy can say. cloudflared sets
 * X-Forwarded-Proto (and cf-visitor); `tailscale serve` on 443 is HTTPS by
 * construction but sends no proto header (measured, 1.102), so a port-less
 * *.ts.net Host counts. A local nginx on :80 sets neither — its cookie must
 * not be Secure or the browser drops it.
 */
export function viaHttps(req: IncomingMessage): boolean {
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]!.trim().toLowerCase();
  if (proto === 'https') return true;
  if (/"scheme"\s*:\s*"https"/.test(String(req.headers['cf-visitor'] ?? ''))) return true;
  const host = (req.headers.host ?? '').toLowerCase();
  return host.endsWith('.ts.net');
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return out;
}

/** Normalize what a user types for allow-host: strip scheme, path, port; lowercase. */
export function normalizeHost(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  if (s.includes('://')) {
    try { s = new URL(s).host; } catch { return null; }
  }
  s = s.split('/')[0]!;
  const name = hostnameOf(s);
  if (!name || !/^[a-z0-9.\-:]+$/.test(name)) return null;
  return name;
}
