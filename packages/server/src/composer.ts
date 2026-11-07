/**
 * What the reader's web composer offers while someone types into a Claude Code pane:
 * the `/` commands, the `@agent-` names, and files for `@`.
 *
 * Nothing here is a list written down in ttym. Claude Code is asked, in the pane's own folder,
 * because the answer changes with its version, the folder's skills and commands, the plugins and
 * MCP servers the person has, and their settings.
 *
 *   sdk    `claude -p --input-format stream-json` answers an `initialize` control request with
 *          every command it can run headless (name, description, argument hint), the subagents and
 *          the models, without calling a model. MCP prompts arrive a moment later in
 *          `commands_changed`, so that is waited for.
 *   menu   Commands bound to the terminal (/resume, /permissions, /plan, /btw, /theme …) are not in
 *          that answer, and no other interface lists them. So a Claude is started in a hidden PTY
 *          (a holder no workspace sees), `/` is typed, and its own menu is read to the end.
 *          Measured 2026-11-07 on 2.1.319: 217 commands in 2.5 s at 220×100.
 *
 * Each source fails on its own (an untrusted folder shows a dialog instead of a menu; a missing
 * binary fails both); whatever answered is used. Results are kept per folder until the folder's
 * skill/command directories, settings or the Claude binary change, or an hour passes.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Session, buildSessionEnv } from './session.js';

export interface ComposerCommand {
  /** With the slash: "/compact", "/figma:x (MCP)". */
  name: string;
  description: string;
  argumentHint?: string;
  /** Listed by Claude's terminal menu only (it does not run headless). */
  terminalOnly?: boolean;
}

export interface ComposerAgent { name: string; description: string }

export interface ComposerCatalog {
  cwd: string;
  commands: ComposerCommand[];
  agents: ComposerAgent[];
  /** Which sources answered, and why one did not. */
  sources: { sdk: 'ok' | string; menu: 'ok' | string };
  version: string | null;
  at: number;
  ms: number;
}

/** Changes to skill/command dirs, settings and the binary are caught by `freshnessKey`; this bounds the rest (an MCP server connected later). */
const TTL_MS = 60 * 60_000;
const SDK_TIMEOUT_MS = 15_000;
const MENU_TIMEOUT_MS = 30_000;
/** The hidden terminal is wide so names are not cut, and tall so a page holds many entries. */
const MENU_COLS = 220;
const MENU_ROWS = 100;

/** Environment for the Claudes started here: the session scrub, and nothing that ties them to a ttym pane (its hooks would report into it). */
function probeEnv(): Record<string, string> {
  const env = buildSessionEnv();
  for (const k of Object.keys(env)) if (k.startsWith('TTYM_')) delete env[k];
  return env;
}

/** A login shell finds `claude` the way the person's own terminal does; a server under launchd may not have it on PATH. */
function shellCommand(line: string): string[] {
  return [process.env.SHELL || '/bin/zsh', '-lc', line];
}

// ───── sdk ─────

interface SdkAnswer { commands: ComposerCommand[]; agents: ComposerAgent[]; version: string | null }

export function sdkInitialize(cwd: string, timeoutMs = SDK_TIMEOUT_MS): Promise<SdkAnswer> {
  return new Promise((done, fail) => {
    const [sh, ...args] = shellCommand('exec claude -p --input-format stream-json --output-format stream-json --verbose --no-session-persistence');
    const child = spawn(sh!, args, { cwd, env: probeEnv(), stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    let answer: SdkAnswer | null = null;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const finish = (err?: Error) => {
      clearTimeout(timer); clearTimeout(settle);
      try { child.kill('SIGTERM'); } catch {}
      if (answer) done(answer); else fail(err ?? new Error('no initialize response'));
    };
    const timer = setTimeout(() => finish(new Error('timed out')), timeoutMs);
    const toCommands = (list: unknown): ComposerCommand[] => (Array.isArray(list) ? list : [])
      .filter((c): c is { name: string; description?: string; argumentHint?: string } => !!c && typeof c.name === 'string')
      .map((c) => ({ name: `/${c.name}`, description: c.description ?? '', ...(c.argumentHint ? { argumentHint: c.argumentHint } : null) }));
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let msg: Record<string, any>;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === 'control_response' && msg.response?.subtype === 'success') {
          const r = msg.response.response ?? {};
          answer = {
            commands: toCommands(r.commands),
            agents: (Array.isArray(r.agents) ? r.agents : []).filter((a: any) => a && typeof a.name === 'string')
              .map((a: any) => ({ name: a.name, description: a.description ?? '' })),
            version: typeof r.claude_code_version === 'string' ? r.claude_code_version : null,
          };
          // MCP servers connect after this and send the full list again; give them a moment.
          settle = setTimeout(() => finish(), 4_000);
        } else if (msg.type === 'system' && msg.subtype === 'commands_changed' && answer) {
          answer.commands = toCommands(msg.commands);
          clearTimeout(settle);
          settle = setTimeout(() => finish(), 1_200);
        }
      }
    });
    child.on('error', (e) => finish(e));
    child.on('exit', () => { if (!answer) finish(new Error('claude exited')); });
    child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'ttym-composer', request: { subtype: 'initialize' } }) + '\n');
  });
}

// ───── menu ─────

/** "  ❯ * /name   description" — the selected row carries ❯, a skill may carry *, a long name may be cut with … at its front. */
const MENU_ROW = /^\s{2,}(?:❯\s+)?(?:\*\s+)?(\/\S+(?: \(MCP\))?|…\S+(?: \(MCP\))?)(?:\s+[–-]\s+|\s{2,})?(.*)$/;
const CONTINUATION = /^\s{20,}(\S.*)$/;
const SELECTED = /^\s{2,}❯\s+(?:\*\s+)?(\S+)/;

/** Parse the menu part of a screen (rows below the prompt's bottom rule): entries with their description, wrapped lines joined. */
export function parseMenu(rows: string[]): { name: string; description: string }[] {
  const out: { name: string; description: string }[] = [];
  for (const row of rows) {
    const m = MENU_ROW.exec(row);
    if (m && m[1]!.startsWith('/')) { out.push({ name: m[1]!, description: (m[2] ?? '').trim() }); continue; }
    const c = CONTINUATION.exec(row);
    if (c && out.length) out[out.length - 1]!.description = `${out[out.length - 1]!.description} ${c[1]!.trim()}`.trim();
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Rows after the second-to-last rule pair: what Claude draws under its prompt. */
function belowPrompt(text: string): string[] {
  const rows = text.split('\n');
  const rules = rows.map((r, i) => (/^─{8,}/.test(r.trim()) ? i : -1)).filter((i) => i >= 0);
  if (rules.length < 2) return [];
  return rows.slice(rules[1]! + 1);
}

let probeSeq = 0;

export async function menuScan(cwd: string, timeoutMs = MENU_TIMEOUT_MS): Promise<ComposerCommand[]> {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'ttym-composer-'));
  // An id no manager hands out; the runtime dir is private, so nothing recovers or lists this session.
  const id = 9_000_000 + (++probeSeq % 100_000);
  let session: Session | null = null;
  const deadline = Date.now() + timeoutMs;
  try {
    session = await Session.create(id, shellCommand('exec claude'), MENU_COLS, MENU_ROWS, runtimeDir, cwd, probeEnv());
    const s = session;
    // The prompt is up when its two rules and the ❯ row are drawn.
    for (;;) {
      if (Date.now() > deadline || s.isDead) throw new Error('claude did not start');
      const text = s.screenText();
      if (/trust (this|the files in this) folder|Do you trust/i.test(text)) throw new Error('folder not trusted');
      const rows = text.split('\n');
      const rules = rows.map((r, i) => (/^─{8,}/.test(r.trim()) ? i : -1)).filter((i) => i >= 0);
      if (rules.length >= 2 && /^\s*❯/.test(rows[rules[rules.length - 2]! + 1] ?? '')) break;
      await sleep(150);
    }
    await sleep(400);
    s.write(Buffer.from('/'));
    await sleep(500);
    const seen = new Map<string, ComposerCommand>();
    // The selection moves inside the visible window before the window scrolls, so a page with nothing new
    // is normal. The list wraps at its end: the scan is over when the selection comes back to where it began.
    const selectedOf = (rows: string[]) => rows.map((r) => SELECTED.exec(r)?.[1]).find(Boolean) ?? null;
    let first: string | null = null;
    let moved = 0;
    let quiet = 0;
    while (Date.now() < deadline && quiet < 8) {
      const rows = belowPrompt(s.screenText());
      const page = parseMenu(rows);
      const before = seen.size;
      for (const e of page) if (!seen.has(e.name)) seen.set(e.name, { name: e.name, description: e.description });
      quiet = seen.size === before ? quiet + 1 : 0;
      const selected = selectedOf(rows);
      if (first === null) first = selected;
      else if (moved > 0 && selected === first) break;
      // Move by what a page shows, less one, so no entry is stepped over.
      const step = Math.max(1, page.length - 1);
      s.write(Buffer.from('\x1b[B'.repeat(step)));
      moved += step;
      // Wait for the selection to be drawn somewhere else before reading again.
      for (let t = 0; t < 600; t += 40) {
        await sleep(40);
        const now = selectedOf(belowPrompt(s.screenText()));
        if (now !== selected) break;
      }
    }
    if (seen.size === 0) throw new Error('no menu');
    return [...seen.values()];
  } finally {
    if (session) {
      // Leave the way a person would, so Claude cleans up after itself; then make sure.
      try { session.write(Buffer.from('\x1b\x15\x03')); await sleep(150); session.write(Buffer.from('\x03')); } catch {}
      for (let t = 0; t < 2_000 && !session.isDead; t += 100) await sleep(100);
      try { session.kill(); } catch {}
    }
    try { rmSync(runtimeDir, { recursive: true, force: true }); } catch {}
  }
}

// ───── catalog ─────

function mtimeOf(path: string): number {
  try { return statSync(path).mtimeMs; } catch { return 0; }
}

/** What would change the answer for a folder: its own and the user's skill/command dirs, plugins, settings. */
function freshnessKey(cwd: string): string {
  const home = process.env.CLAUDE_CONFIG_DIR || resolve(process.env.HOME || '/tmp', '.claude');
  const watched = [
    join(cwd, '.claude', 'skills'), join(cwd, '.claude', 'commands'), join(cwd, '.claude', 'settings.json'),
    join(home, 'skills'), join(home, 'commands'), join(home, 'settings.json'), join(home, 'plugins', 'installed_plugins.json'),
    resolve(process.env.HOME || '/tmp', '.local', 'bin', 'claude'),
  ];
  return watched.map(mtimeOf).join(':');
}

const cache = new Map<string, { key: string; catalog: ComposerCatalog }>();
const inflight = new Map<string, Promise<ComposerCatalog>>();
/**
 * One folder is asked at a time: each ask starts two Claudes, and after a server restart every reader pane in
 * a different folder would ask at once (on a machine already short of memory, 2026-11-06).
 */
let probeQueue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(job: () => Promise<T>): Promise<T> {
  const run = probeQueue.then(job, job);
  probeQueue = run.catch(() => {});
  return run;
}

export function mergeCommands(sdk: ComposerCommand[], menu: ComposerCommand[]): ComposerCommand[] {
  const bySdk = new Map(sdk.map((c) => [c.name, c]));
  const out: ComposerCommand[] = [];
  const done = new Set<string>();
  // Claude's menu order first (it ranks by use), with the fuller description and argument hint from the sdk.
  for (const m of menu) {
    const s = bySdk.get(m.name);
    out.push(s ? { ...s, description: s.description || m.description } : { ...m, terminalOnly: true });
    done.add(m.name);
  }
  for (const s of sdk) if (!done.has(s.name)) out.push(s);
  return out;
}

export async function composerCatalog(cwd: string, opts: { force?: boolean } = {}): Promise<ComposerCatalog> {
  const key = freshnessKey(cwd);
  const hit = cache.get(cwd);
  if (!opts.force && hit && hit.key === key && Date.now() - hit.catalog.at < TTL_MS) return hit.catalog;
  const running = inflight.get(cwd);
  if (running) return running;
  const job = oneAtATime(async () => {
    const t0 = Date.now();
    const [sdk, menu] = await Promise.allSettled([sdkInitialize(cwd), menuScan(cwd)]);
    const sdkOk = sdk.status === 'fulfilled' ? sdk.value : null;
    const menuOk = menu.status === 'fulfilled' ? menu.value : [];
    const catalog: ComposerCatalog = {
      cwd,
      commands: mergeCommands(sdkOk?.commands ?? [], menuOk),
      agents: sdkOk?.agents ?? [],
      sources: {
        sdk: sdk.status === 'fulfilled' ? 'ok' : String((sdk.reason as Error)?.message ?? sdk.reason),
        menu: menu.status === 'fulfilled' ? 'ok' : String((menu.reason as Error)?.message ?? menu.reason),
      },
      version: sdkOk?.version ?? null,
      at: Date.now(),
      ms: Date.now() - t0,
    };
    if (catalog.commands.length) cache.set(cwd, { key, catalog });
    return catalog;
  }).finally(() => inflight.delete(cwd));
  inflight.set(cwd, job);
  return job;
}

// ───── files for @ ─────

const FILE_LIMIT = 20_000;
const fileCache = new Map<string, { at: number; files: string[] }>();

function listFiles(cwd: string): Promise<string[]> {
  const hit = fileCache.get(cwd);
  if (hit && Date.now() - hit.at < 15_000) return Promise.resolve(hit.files);
  return new Promise((done) => {
    // rg honours .gitignore the way Claude's own @ does; without rg, nothing rather than a walk of node_modules.
    const child = spawn('rg', ['--files', '--hidden', '-g', '!.git'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (c: Buffer) => { if (out.length < 4 << 20) out += c.toString(); });
    const end = () => {
      const files = out.split('\n').filter(Boolean).slice(0, FILE_LIMIT).sort();
      fileCache.set(cwd, { at: Date.now(), files });
      done(files);
    };
    child.on('close', end);
    child.on('error', () => done([]));
  });
}

/** Rank by: name starts with the query, path contains it, then the letters in order. */
export function rankFiles(files: string[], q: string, limit = 30): string[] {
  const query = q.toLowerCase();
  if (!query) return files.slice(0, limit);
  const scored: { f: string; s: number }[] = [];
  for (const f of files) {
    const lf = f.toLowerCase();
    const base = lf.slice(lf.lastIndexOf('/') + 1);
    let s = -1;
    if (base.startsWith(query)) s = 0;
    else if (lf.includes(query)) s = 1;
    else {
      let i = 0;
      for (const ch of lf) if (ch === query[i]) i++;
      if (i === query.length) s = 2;
    }
    if (s >= 0) scored.push({ f, s: s * 10_000 + f.length });
  }
  return scored.sort((a, b) => a.s - b.s).slice(0, limit).map((x) => x.f);
}

export async function composerFiles(cwd: string, q: string): Promise<string[]> {
  return rankFiles(await listFiles(cwd), q);
}

// ───── the pane's Claude ─────

/** The folder a pane's Claude runs in (its own cwd, which can differ from the shell's after `cd`). */
export async function claudeCwd(pid: number): Promise<string | undefined> {
  if (process.platform === 'linux') {
    try { const { readlink } = await import('node:fs/promises'); return await readlink(`/proc/${pid}/cwd`); } catch { return undefined; }
  }
  return new Promise((done) => {
    let out = '';
    const p = spawn('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { stdio: ['ignore', 'pipe', 'ignore'] });
    p.stdout.on('data', (c: Buffer) => { out += c.toString(); });
    p.on('close', () => done(out.split('\n').find((l) => l.startsWith('n'))?.slice(1)));
    p.on('error', () => done(undefined));
  });
}


