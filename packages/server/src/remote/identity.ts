/**
 * Who the proxy in front of us says the visitor is — checked, not believed.
 *
 * A remote request without a ttym cookie may still carry an identity that an
 * allow-listed login or email vouches for. When one checks out, the gate
 * issues the usual 30-day cookie and lets it through: one login (Tailscale
 * account, Cloudflare Access) instead of two. When nothing checks out, the
 * one-time link stays the way in.
 *
 * Tailscale: `tailscale serve` overwrites Tailscale-User-Login and replaces
 * X-Forwarded-For with the real tailnet peer (both measured on 1.102 with
 * forged headers). A forged header can still arrive by another road — a LAN
 * client through a local nginx — so the header is only a claim: the last
 * X-Forwarded-For hop must be a tailnet address, and tailscaled's whois for
 * that address must name the same login.
 *
 * Cloudflare Access: the Cf-Access-Jwt-Assertion JWT is verified against the
 * team's published keys (RS256), with the issuer and the app's aud pinned and
 * the email checked against ttym's own list — so a loosened Access policy
 * still does not let other emails in.
 */
import type { IncomingMessage } from 'node:http';
import { createPublicKey, verify as cryptoVerify, type JsonWebKey } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface CloudflareTrust { team: string; aud: string; emails: string[] }
export interface TrustConfig {
  tailscale?: { logins: string[] };
  cloudflare?: CloudflareTrust[];
}

export interface Identity { via: 'tailscale' | 'cloudflare'; who: string }

export interface IdentityDeps {
  /** tailnet address → login name, or null. */
  whois: (ip: string) => Promise<string | null>;
  /** team → its JWKS keys; `refresh` skips the cache (key rotation). */
  fetchCerts: (team: string, refresh?: boolean) => Promise<JsonWebKey[]>;
  now: () => number;
}

// ───── Tailscale ─────

/** 100.64.0.0/10 (CGNAT range Tailscale uses) or fd7a:115c:a1e0::/48. */
export function isTailnetAddress(ip: string): boolean {
  const v4 = ip.replace(/^::ffff:/, '');
  const m = v4.match(/^100\.(\d+)\.\d+\.\d+$/);
  if (m) { const b = Number(m[1]); return b >= 64 && b <= 127; }
  return ip.toLowerCase().startsWith('fd7a:115c:a1e0:');
}

function lastForwardedHop(req: IncomingMessage): string | null {
  const xff = req.headers['x-forwarded-for'];
  const list = (Array.isArray(xff) ? xff.join(',') : xff ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list[list.length - 1]! : null;
}

async function tailscaleIdentity(req: IncomingMessage, trust: TrustConfig, deps: IdentityDeps): Promise<Identity | null> {
  const logins = trust.tailscale?.logins ?? [];
  if (!logins.length) return null;
  const claimed = req.headers['tailscale-user-login'];
  if (typeof claimed !== 'string' || !logins.includes(claimed.toLowerCase())) return null;
  if (req.headers['cf-connecting-ip'] || req.headers['cf-ray']) return null;
  const peer = lastForwardedHop(req);
  if (!peer || !isTailnetAddress(peer)) return null;
  const owner = await deps.whois(peer);
  if (!owner || owner.toLowerCase() !== claimed.toLowerCase()) return null;
  return { via: 'tailscale', who: owner.toLowerCase() };
}

const TS_CANDIDATES = ['/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/usr/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
const whoisCache = new Map<string, { login: string | null; at: number }>();

/** `tailscale whois --json <ip>` → UserProfile.LoginName, cached for five minutes. */
export function tailscaleWhois(ip: string): Promise<string | null> {
  const hit = whoisCache.get(ip);
  if (hit && Date.now() - hit.at < 5 * 60_000) return Promise.resolve(hit.login);
  const bin = process.env.TTYM_TAILSCALE_BIN ?? TS_CANDIDATES.find((p) => existsSync(p)) ?? 'tailscale';
  return new Promise((resolve) => {
    execFile(bin, ['whois', '--json', ip], { timeout: 5000 }, (err, stdout) => {
      let login: string | null = null;
      if (!err) { try { login = JSON.parse(stdout)?.UserProfile?.LoginName ?? null; } catch {} }
      whoisCache.set(ip, { login, at: Date.now() });
      resolve(login);
    });
  });
}

// ───── Cloudflare Access ─────

const b64json = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

export async function verifyAccessJwt(token: string, entry: CloudflareTrust, deps: IdentityDeps): Promise<string | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header: { alg?: string; kid?: string }, payload: { iss?: string; aud?: string | string[]; exp?: number; nbf?: number; email?: string };
  try { header = b64json(parts[0]!); payload = b64json(parts[1]!); } catch { return null; }
  if (header.alg !== 'RS256' || !header.kid) return null;
  const now = deps.now() / 1000;
  if (typeof payload.exp !== 'number' || payload.exp < now - 30) return null;
  if (typeof payload.nbf === 'number' && payload.nbf > now + 30) return null;
  if (payload.iss !== `https://${entry.team}.cloudflareaccess.com`) return null;
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(entry.aud)) return null;
  const email = payload.email?.toLowerCase();
  if (!email || !entry.emails.includes(email)) return null;

  const findKey = async (refresh: boolean) => (await deps.fetchCerts(entry.team, refresh)).find((k) => k.kid === header.kid);
  const jwk = (await findKey(false)) ?? (await findKey(true)); // keys rotate: one refetch on an unknown kid
  if (!jwk) return null;
  try {
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    const ok = cryptoVerify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2]!, 'base64url'));
    return ok ? email : null;
  } catch { return null; }
}

async function cloudflareIdentity(req: IncomingMessage, trust: TrustConfig, deps: IdentityDeps): Promise<Identity | null> {
  const token = req.headers['cf-access-jwt-assertion'];
  if (typeof token !== 'string' || !trust.cloudflare?.length) return null;
  for (const entry of trust.cloudflare) {
    const email = await verifyAccessJwt(token, entry, deps);
    if (email) return { via: 'cloudflare', who: email };
  }
  return null;
}

const certCache = new Map<string, { keys: JsonWebKey[]; at: number }>();

/** The team's JWKS, cached for an hour. */
export async function fetchAccessCerts(team: string, refresh = false): Promise<JsonWebKey[]> {
  const hit = certCache.get(team);
  if (hit && !refresh && Date.now() - hit.at < 60 * 60_000) return hit.keys;
  try {
    const res = await fetch(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000) });
    const keys = ((await res.json()) as { keys?: JsonWebKey[] }).keys ?? [];
    certCache.set(team, { keys, at: Date.now() });
    return keys;
  } catch { return hit?.keys ?? []; }
}

export const defaultIdentityDeps: IdentityDeps = { whois: tailscaleWhois, fetchCerts: fetchAccessCerts, now: () => Date.now() };

export async function resolveIdentity(req: IncomingMessage, trust: TrustConfig, deps: IdentityDeps = defaultIdentityDeps): Promise<Identity | null> {
  return (await cloudflareIdentity(req, trust, deps)) ?? (await tailscaleIdentity(req, trust, deps));
}

/** Anything worth an async identity check? Keeps the common no-identity 401 synchronous. */
export function mayCarryIdentity(req: IncomingMessage, trust: TrustConfig): boolean {
  return (!!trust.cloudflare?.length && typeof req.headers['cf-access-jwt-assertion'] === 'string')
    || (!!trust.tailscale?.logins.length && typeof req.headers['tailscale-user-login'] === 'string');
}
