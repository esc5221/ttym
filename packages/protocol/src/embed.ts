/**
 * Embedding ttym in another app (docs/embedding.md) — the shapes the
 * server, the CLI and the panel agree on.
 *
 *   consumer  an app registered on the ttym machine (~/.ttym/embed-consumers.json):
 *             its key, the origins it serves from, the workspaces it may hand out,
 *             and the named commands a new tab may run
 *   grant     what the consumer's backend asks for on behalf of one person: which
 *             workspaces or sessions, with which capabilities, for how long
 *
 * Only parsing and the contract live here. Hashing and file IO are each side's
 * own (node:crypto would not load in the panel).
 */

/** The public embed API major. Paths carry it (/api/embed/v1, /embed/v1/). */
export const EMBED_API_VERSION = 1;
/** The SDK (/embed/v1/sdk.js) major — methods, events, mount options. */
export const EMBED_SDK_VERSION = 2;

export const EMBED_CAPS = ['terminal.read', 'terminal.write', 'tabs.write'] as const;
export type EmbedCap = (typeof EMBED_CAPS)[number];

export interface SpawnProfile {
  cmd: string[];
  cwd?: string;
  maxTabs: number;
  /** Closing the last tab opens a fresh one, so the panel is never empty. */
  keepOne: boolean;
}

export interface EmbedConsumer {
  /** sha256 of the key, "sha256:<hex>". The key itself is printed once and never stored. */
  keyHash: string;
  origins: string[];
  /** Exact workspace ids. A session grant must name a session inside one of them. */
  workspaces: string[];
  maxTtlMs: number;
  profiles: Record<string, SpawnProfile>;
}

export type EmbedConsumers = Record<string, EmbedConsumer>;

export type EmbedAccess =
  | { workspace: string; caps: EmbedCap[]; profile?: string }
  | { session: number; caps: EmbedCap[] };

export interface EmbedGrantRequest {
  subject?: string;
  ttlMs?: number;
  access: EmbedAccess[];
}

export interface EmbedGrantResponse {
  grant: string;
  id: string;
  expiresAt: number;
  access: EmbedAccess[];
}

export interface EmbedTab {
  sid: number;
  name: string;
  status: 'running' | 'exited' | 'gone';
  createdAt: number;
}

export const DEFAULT_GRANT_TTL_MS = 30 * 60_000;
export const DEFAULT_MAX_TTL_MS = 12 * 60 * 60_000;
export const ORIGIN_RE = /^https?:\/\/[^/\s]+$/;
export const EMBED_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** Read the consumers file. Malformed entries are dropped with a reason, not thrown — one typo must not lock every consumer out. */
export function parseConsumers(raw: unknown): { consumers: EmbedConsumers; problems: string[] } {
  const consumers: EmbedConsumers = {};
  const problems: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { consumers, problems: raw === undefined ? [] : ['file is not an object of id → consumer'] };
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const c = value as Partial<EmbedConsumer> | null;
    if (!EMBED_ID_RE.test(id)) { problems.push(`${id}: bad id`); continue; }
    if (!c || typeof c !== 'object') { problems.push(`${id}: not an object`); continue; }
    if (typeof c.keyHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(c.keyHash)) { problems.push(`${id}: keyHash`); continue; }
    const origins = Array.isArray(c.origins) ? c.origins.filter((o): o is string => typeof o === 'string' && ORIGIN_RE.test(o)) : [];
    const workspaces = Array.isArray(c.workspaces) ? c.workspaces.filter((w): w is string => typeof w === 'string' && w.length > 0) : [];
    const profiles: Record<string, SpawnProfile> = {};
    for (const [name, p] of Object.entries(c.profiles && typeof c.profiles === 'object' ? c.profiles : {})) {
      const prof = p as Partial<SpawnProfile>;
      if (!Array.isArray(prof?.cmd) || prof.cmd.length === 0 || !prof.cmd.every((x) => typeof x === 'string')) { problems.push(`${id}: profile ${name} cmd`); continue; }
      profiles[name] = {
        cmd: prof.cmd,
        ...(typeof prof.cwd === 'string' && prof.cwd ? { cwd: prof.cwd } : {}),
        maxTabs: Number.isInteger(prof.maxTabs) && prof.maxTabs! > 0 ? prof.maxTabs! : 8,
        keepOne: prof.keepOne === true,
      };
    }
    consumers[id] = {
      keyHash: c.keyHash,
      origins,
      workspaces,
      maxTtlMs: Number.isInteger(c.maxTtlMs) && c.maxTtlMs! > 0 ? c.maxTtlMs! : DEFAULT_MAX_TTL_MS,
      profiles,
    };
  }
  return { consumers, problems };
}

/**
 * Check a grant request against the consumer's registration. Anything outside it
 * is an error, never quietly narrowed: a consumer that asked for more than it got
 * would not know which of its users are running with less.
 *
 * `sessionWorkspace` says which workspace a session belongs to right now.
 */
export function checkGrantRequest(
  consumer: EmbedConsumer,
  body: unknown,
  sessionWorkspace: (sid: number) => string | undefined,
): { ok: true; access: EmbedAccess[]; ttlMs: number; subject: string } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be an object' };
  const b = body as Record<string, unknown>;
  const ttlMs = b.ttlMs === undefined ? Math.min(DEFAULT_GRANT_TTL_MS, consumer.maxTtlMs) : b.ttlMs;
  if (typeof ttlMs !== 'number' || !Number.isInteger(ttlMs) || ttlMs < 10_000) return { ok: false, error: 'ttlMs must be an integer ≥ 10000' };
  if (ttlMs > consumer.maxTtlMs) return { ok: false, error: `ttlMs exceeds this consumer's maxTtlMs (${consumer.maxTtlMs})` };
  const subject = typeof b.subject === 'string' ? b.subject.slice(0, 200) : '';
  if (!Array.isArray(b.access) || b.access.length === 0) return { ok: false, error: 'access must be a non-empty array' };
  if (b.access.length > 16) return { ok: false, error: 'at most 16 access entries' };
  const out: EmbedAccess[] = [];
  for (const [i, raw] of (b.access as unknown[]).entries()) {
    const at = `access[${i}]`;
    if (!raw || typeof raw !== 'object') return { ok: false, error: `${at}: must be an object` };
    const a = raw as Record<string, unknown>;
    const known = new Set(['workspace', 'session', 'caps', 'profile']);
    const unknownKey = Object.keys(a).find((k) => !known.has(k));
    if (unknownKey) return { ok: false, error: `${at}: unknown field ${unknownKey}` };
    if (!Array.isArray(a.caps) || a.caps.length === 0) return { ok: false, error: `${at}: caps must be a non-empty array` };
    const caps = [...new Set(a.caps)] as unknown[];
    const bad = caps.find((c) => typeof c !== 'string' || !(EMBED_CAPS as readonly string[]).includes(c));
    if (bad !== undefined) return { ok: false, error: `${at}: unknown capability ${String(bad)}` };
    const typed = caps as EmbedCap[];
    if (!typed.includes('terminal.read')) return { ok: false, error: `${at}: every entry needs terminal.read` };
    const hasWs = a.workspace !== undefined;
    const hasSession = a.session !== undefined;
    if (hasWs === hasSession) return { ok: false, error: `${at}: name exactly one of workspace or session` };
    if (hasWs) {
      if (typeof a.workspace !== 'string' || !consumer.workspaces.includes(a.workspace)) return { ok: false, error: `${at}: workspace not registered for this consumer` };
      if (typed.includes('tabs.write')) {
        if (typeof a.profile !== 'string') return { ok: false, error: `${at}: tabs.write needs a profile` };
        if (!consumer.profiles[a.profile]) return { ok: false, error: `${at}: unknown profile ${a.profile}` };
      } else if (a.profile !== undefined) {
        return { ok: false, error: `${at}: profile is only for tabs.write` };
      }
      out.push({ workspace: a.workspace, caps: typed, ...(typeof a.profile === 'string' ? { profile: a.profile } : {}) });
    } else {
      if (typeof a.session !== 'number' || !Number.isInteger(a.session) || a.session <= 0) return { ok: false, error: `${at}: session must be a session id` };
      if (typed.includes('tabs.write')) return { ok: false, error: `${at}: tabs.write is for workspace entries` };
      if (a.profile !== undefined) return { ok: false, error: `${at}: profile is for workspace entries` };
      const ws = sessionWorkspace(a.session);
      if (!ws || !consumer.workspaces.includes(ws)) return { ok: false, error: `${at}: session is not in a workspace registered for this consumer` };
      out.push({ session: a.session, caps: typed });
    }
  }
  return { ok: true, access: out, ttlMs, subject };
}

/** The capabilities a grant holds on one session, given where that session is now. */
export function capsOn(access: readonly EmbedAccess[], sid: number, workspaceOf: string | undefined): Set<EmbedCap> {
  const caps = new Set<EmbedCap>();
  for (const a of access) {
    const hit = 'session' in a ? a.session === sid : workspaceOf !== undefined && a.workspace === workspaceOf;
    if (hit) for (const c of a.caps) caps.add(c);
  }
  return caps;
}

export function grantWorkspaces(access: readonly EmbedAccess[]): Set<string> {
  const out = new Set<string>();
  for (const a of access) if ('workspace' in a) out.add(a.workspace);
  return out;
}
