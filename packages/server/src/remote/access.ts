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
  /** Why it counted as remote — logged on refusals. */
  reason: 'local' | 'peer' | 'host' | 'proxy';
  /** Peer is loopback: a local proxy (tunnel, serve) terminated TLS for us. */
  viaLocalProxy: boolean;
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

export function classify(req: IncomingMessage): Caller {
  const peerLoopback = isLoopbackAddress(req.socket.remoteAddress);
  const hostname = hostnameOf(req.headers.host);
  const base = { hostname, viaLocalProxy: peerLoopback };
  if (!peerLoopback) return { ...base, remote: true, reason: 'peer' };
  if (!isLoopbackHostname(hostname)) return { ...base, remote: true, reason: 'host' };
  if (PROXY_HEADERS.some((h) => req.headers[h] !== undefined)) return { ...base, remote: true, reason: 'proxy' };
  return { ...base, remote: false, reason: 'local' };
}

/** Local callers always name a loopback host (by definition); remote ones need an allow-listed name. */
export function hostAllowed(caller: Caller, allowHosts: ReadonlySet<string>): boolean {
  if (!caller.remote) return true;
  return !!caller.hostname && allowHosts.has(caller.hostname);
}

/**
 * No Origin: not a browser (CLI, curl, hooks) — pass.
 * `null`: sandboxed viewer iframe — refuse.
 * Otherwise the page must be ours: same host as the request, an allow-listed
 * name, or (for local requests only) a loopback page such as the Vite dev
 * server, which proxies with Host rewritten to 127.0.0.1.
 */
export function originAllowed(req: IncomingMessage, caller: Caller, allowHosts: ReadonlySet<string>): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (origin === 'null') return false;
  let url: URL;
  try { url = new URL(origin); } catch { return false; }
  if (req.headers.host && url.host.toLowerCase() === req.headers.host.toLowerCase()) return true;
  const name = hostnameOf(url.host);
  if (!caller.remote && isLoopbackHostname(name)) return true;
  return !!name && allowHosts.has(name);
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
