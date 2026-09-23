/**
 * ~/.ttym/remote.json — allowed remote hostnames and logged-in browsers.
 *
 * Not in the config file on purpose: PATCH /api/config accepts writes, so a
 * host list there could be widened by whoever reaches the API. The server is
 * the only writer here; the CLI goes through the local-only /api/remote
 * routes. Session tokens are stored as sha256 hashes, so reading the file
 * does not log anyone in. Login links live in memory only (10 minutes, one
 * use) — a restart simply voids them.
 */
import { readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import type { TrustConfig, CloudflareTrust } from './identity.js';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const LINK_TTL_MS = 10 * 60 * 1000;
/** lastSeenAt is informational; persist it at most this often. */
const TOUCH_PERSIST_MS = 10 * 60 * 1000;

export interface RemoteSession {
  id: string;
  hash: string;
  host: string | null;
  userAgent: string | null;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  /** How the browser got in: 'link', or 'tailscale:<login>' / 'cloudflare:<email>'. */
  via?: string;
}

interface RemoteFile {
  version: 1;
  allowHosts: string[];
  sessions: RemoteSession[];
  trust?: TrustConfig;
}

export type PublicSession = Omit<RemoteSession, 'hash'>;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const token = () => randomBytes(32).toString('base64url');

export class RemoteStore {
  private hosts = new Set<string>();
  private sessions: RemoteSession[] = [];
  private links = new Map<string, { expiresAt: number; host: string | null }>();
  private trustCfg: TrustConfig = {};
  private lastPersist = 0;

  constructor(private readonly file: string, private readonly now = () => Date.now()) {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as Partial<RemoteFile>;
      for (const h of data.allowHosts ?? []) if (typeof h === 'string') this.hosts.add(h);
      this.sessions = (data.sessions ?? []).filter((s) => s && typeof s.hash === 'string');
      if (data.trust && typeof data.trust === 'object') this.trustCfg = data.trust;
    } catch {}
    this.prune();
  }

  get allowHosts(): ReadonlySet<string> { return this.hosts; }

  addHost(host: string): boolean {
    if (this.hosts.has(host)) return false;
    this.hosts.add(host); this.save(); return true;
  }

  removeHost(host: string): boolean {
    if (!this.hosts.delete(host)) return false;
    this.save(); return true;
  }

  get trust(): TrustConfig { return this.trustCfg; }

  trustTailscale(login: string): boolean {
    const logins = this.trustCfg.tailscale?.logins ?? [];
    const l = login.toLowerCase();
    if (logins.includes(l)) return false;
    this.trustCfg = { ...this.trustCfg, tailscale: { logins: [...logins, l] } };
    this.save(); return true;
  }

  /** One entry per (team, aud); emails merge. */
  trustCloudflare(entry: CloudflareTrust): boolean {
    const list = this.trustCfg.cloudflare ?? [];
    const emails = entry.emails.map((e) => e.toLowerCase());
    const same = list.find((c) => c.team === entry.team && c.aud === entry.aud);
    if (same && emails.every((e) => same.emails.includes(e))) return false;
    const next = same
      ? list.map((c) => c === same ? { ...c, emails: [...new Set([...c.emails, ...emails])] } : c)
      : [...list, { team: entry.team, aud: entry.aud, emails }];
    this.trustCfg = { ...this.trustCfg, cloudflare: next };
    this.save(); return true;
  }

  untrust(kind: 'tailscale' | 'cloudflare' | 'all'): void {
    const next = { ...this.trustCfg };
    if (kind === 'tailscale' || kind === 'all') delete next.tailscale;
    if (kind === 'cloudflare' || kind === 'all') delete next.cloudflare;
    this.trustCfg = next;
    this.save();
  }

  /** A session for a browser whose identity the proxy vouched for (no link). */
  issueSession(meta: { host: string | null; userAgent: string | null; via: string }): { token: string; session: PublicSession } {
    const t = token();
    const now = this.now();
    const session: RemoteSession = {
      id: randomBytes(4).toString('hex'), hash: sha256(t),
      host: meta.host, userAgent: meta.userAgent?.slice(0, 200) ?? null,
      createdAt: now, expiresAt: now + SESSION_TTL_MS, lastSeenAt: now, via: meta.via,
    };
    this.sessions.push(session);
    this.save();
    return { token: t, session: toPublic(session) };
  }

  mintLink(host: string | null): { token: string; expiresAt: number } {
    this.pruneLinks();
    const t = token();
    const expiresAt = this.now() + LINK_TTL_MS;
    this.links.set(sha256(t), { expiresAt, host });
    return { token: t, expiresAt };
  }

  /** One use: the link is gone whether or not it was still valid. */
  redeemLink(linkToken: string, meta: { host: string | null; userAgent: string | null }): { token: string; session: PublicSession } | null {
    const key = sha256(linkToken);
    const link = this.links.get(key);
    this.links.delete(key);
    if (!link || link.expiresAt < this.now()) return null;
    const t = token();
    const now = this.now();
    const session: RemoteSession = {
      id: randomBytes(4).toString('hex'), hash: sha256(t),
      host: meta.host, userAgent: meta.userAgent?.slice(0, 200) ?? null,
      createdAt: now, expiresAt: now + SESSION_TTL_MS, lastSeenAt: now, via: 'link',
    };
    this.sessions.push(session);
    this.save();
    return { token: t, session: toPublic(session) };
  }

  verify(sessionToken: string | undefined): PublicSession | null {
    if (!sessionToken) return null;
    const hash = sha256(sessionToken);
    const s = this.sessions.find((x) => x.hash === hash);
    if (!s) return null;
    const now = this.now();
    if (s.expiresAt < now) { this.prune(); this.save(); return null; }
    s.lastSeenAt = now;
    if (now - this.lastPersist > TOUCH_PERSIST_MS) this.save();
    return toPublic(s);
  }

  list(): PublicSession[] {
    this.prune();
    return this.sessions.map(toPublic);
  }

  /** `all` drops every session. Returns how many went. */
  revoke(id: string): number {
    const before = this.sessions.length;
    this.sessions = id === 'all' ? [] : this.sessions.filter((s) => s.id !== id);
    const n = before - this.sessions.length;
    if (n) this.save();
    return n;
  }

  revokeToken(sessionToken: string): void {
    const hash = sha256(sessionToken);
    const before = this.sessions.length;
    this.sessions = this.sessions.filter((s) => s.hash !== hash);
    if (this.sessions.length !== before) this.save();
  }

  private prune() {
    const now = this.now();
    this.sessions = this.sessions.filter((s) => s.expiresAt >= now);
  }

  private pruneLinks() {
    const now = this.now();
    for (const [k, v] of this.links) if (v.expiresAt < now) this.links.delete(k);
  }

  private save() {
    this.lastPersist = this.now();
    const body: RemoteFile = { version: 1, allowHosts: [...this.hosts].sort(), sessions: this.sessions, trust: this.trustCfg };
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }
}

function toPublic(s: RemoteSession): PublicSession {
  const { hash: _hash, ...pub } = s;
  return pub;
}
