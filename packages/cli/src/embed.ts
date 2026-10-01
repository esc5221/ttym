import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { parseConsumers, ORIGIN_RE, EMBED_ID_RE, DEFAULT_MAX_TTL_MS, type EmbedConsumer, type EmbedConsumers } from '@ttym/protocol';
import { EXIT, HOME_DIR, hasFlag } from './common.js';

/**
 * ttym embed — register the apps that put a ttym panel in their own pages
 * (docs/embedding.md).
 *
 * The registrations are a file on this machine, ~/.ttym/embed-consumers.json.
 * The server re-reads it when it changes; nothing here needs the server running.
 * A key is printed once and only its hash is stored.
 */
const HELP = `usage: ttym embed consumer <command>

  add <id> --origin <url> --workspace <ws> --profile <name>=<cmd>   Register an app; prints its key once
        [--origin …] [--workspace …] [--profile …]   repeat for more
        [--cwd <dir>] [--max-tabs <n>] [--keep-one] [--max-ttl 12h]   apply to the profiles given here
  list [--json]                     Registered apps (never the keys)
  rotate <id>                       New key; grants minted with the old one end now
  remove <id>                       Unregister; its grants end now

  The app's backend then asks POST /api/embed/v1/grants with Authorization: Bearer <key>.
  Guide: docs/embedding.md`;

const FILE = resolve(HOME_DIR, 'embed-consumers.json');

function load(): EmbedConsumers {
  if (!existsSync(FILE)) return {};
  const { consumers, problems } = parseConsumers(JSON.parse(readFileSync(FILE, 'utf8')));
  for (const p of problems) console.error(`warning: ${FILE}: skipped ${p}`);
  return consumers;
}

function save(consumers: EmbedConsumers) {
  mkdirSync(HOME_DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(consumers, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, FILE);
}

const newKey = () => 'ttym_ek_' + randomBytes(32).toString('base64url');
const hashKey = (key: string) => 'sha256:' + createHash('sha256').update(key).digest('hex');

/** Every value after each occurrence of a flag. */
function readAll(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === flag && args[i + 1] !== undefined) out.push(args[++i]!);
  return out;
}

/** "zsh -l" → ["zsh","-l"]; single and double quotes group words. No variables or globs. */
export function splitCommand(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let any = false;
  for (const ch of s) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; any = true; continue; }
    if (/\s/.test(ch)) { if (cur || any) { out.push(cur); cur = ''; any = false; } continue; }
    cur += ch;
  }
  if (cur || any) out.push(cur);
  return out;
}

function parseDuration(s: string): number | null {
  const m = s.trim().match(/^(\d+)\s*(s|m|h|d)?$/);
  if (!m) return null;
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[(m[2] ?? 'm') as 's' | 'm' | 'h' | 'd'];
  return parseInt(m[1]!, 10) * unit;
}

function fail(message: string, code = EXIT.USAGE): never {
  console.error(message);
  process.exit(code);
}

export async function cmdEmbed() {
  const [group, sub, ...rest] = process.argv.slice(3);
  if (!group || group === 'help' || group === '--help' || group === '-h') { console.log(HELP); process.exit(group ? EXIT.OK : EXIT.USAGE); }
  if (group !== 'consumer') fail(HELP);
  const json = hasFlag('--json');

  switch (sub) {
    case 'add': {
      const id = rest[0];
      if (!id || id.startsWith('--') || !EMBED_ID_RE.test(id)) fail('add <id>: letters, digits, _ . - (up to 64)');
      const consumers = load();
      if (consumers[id]) fail(`consumer ${id} already exists — \`ttym embed consumer remove ${id}\` first, or rotate its key`);
      const origins = readAll(rest, '--origin').map((o) => o.replace(/\/+$/, ''));
      const bad = origins.find((o) => !ORIGIN_RE.test(o));
      if (bad) fail(`--origin ${bad}: scheme and host only, like https://app.example.com`);
      if (!origins.length) fail('--origin is required: the page origin the panel is framed from');
      const workspaces = readAll(rest, '--workspace');
      if (!workspaces.length) fail('--workspace is required: which workspace(s) this app may hand out');
      const cwd = readAll(rest, '--cwd')[0];
      const maxTabsRaw = readAll(rest, '--max-tabs')[0];
      const maxTabs = maxTabsRaw ? parseInt(maxTabsRaw, 10) : 8;
      if (!Number.isInteger(maxTabs) || maxTabs < 1) fail('--max-tabs must be a positive integer');
      const ttlRaw = readAll(rest, '--max-ttl')[0];
      const maxTtlMs = ttlRaw ? parseDuration(ttlRaw) : DEFAULT_MAX_TTL_MS;
      if (!maxTtlMs) fail('--max-ttl like 30m, 12h, 1d');
      const profiles: EmbedConsumer['profiles'] = {};
      for (const spec of readAll(rest, '--profile')) {
        const eq = spec.indexOf('=');
        const name = eq > 0 ? spec.slice(0, eq) : '';
        const cmd = splitCommand(eq > 0 ? spec.slice(eq + 1) : '');
        if (!name || !cmd.length) fail(`--profile ${spec}: want name=command, like default='zsh -l'`);
        profiles[name] = { cmd, ...(cwd ? { cwd: resolve(cwd) } : {}), maxTabs, keepOne: rest.includes('--keep-one') };
      }
      const key = newKey();
      consumers[id] = { keyHash: hashKey(key), origins, workspaces, maxTtlMs, profiles };
      save(consumers);
      if (json) { console.log(JSON.stringify({ id, key, consumer: { ...consumers[id], keyHash: undefined } }, null, 2)); return; }
      console.log(`registered ${id}`);
      console.log(`  origins     ${origins.join(' ')}`);
      console.log(`  workspaces  ${workspaces.join(' ')}`);
      console.log(`  profiles    ${Object.keys(profiles).join(' ') || '(none — grants cannot open tabs)'}`);
      console.log('');
      console.log(`key (shown once — put it in the app's backend config):`);
      console.log(`  ${key}`);
      return;
    }
    case 'list': {
      const consumers = load();
      const rows = Object.entries(consumers).map(([id, c]) => ({ id, origins: c.origins, workspaces: c.workspaces, maxTtlMs: c.maxTtlMs, profiles: c.profiles }));
      if (json) { console.log(JSON.stringify({ file: FILE, consumers: rows }, null, 2)); return; }
      if (!rows.length) { console.log(`no consumers (${FILE})`); return; }
      for (const r of rows) {
        console.log(`${r.id}`);
        console.log(`  origins     ${r.origins.join(' ')}`);
        console.log(`  workspaces  ${r.workspaces.join(' ')}`);
        console.log(`  max ttl     ${Math.round(r.maxTtlMs / 60_000)}m`);
        for (const [name, p] of Object.entries(r.profiles)) console.log(`  profile     ${name} = ${p.cmd.join(' ')}${p.cwd ? `  (cwd ${p.cwd})` : ''}  max ${p.maxTabs}${p.keepOne ? '  keep-one' : ''}`);
      }
      return;
    }
    case 'rotate': {
      const id = rest[0];
      const consumers = load();
      if (!id || !consumers[id]) fail(`no consumer ${id ?? ''}`, EXIT.NOT_FOUND);
      const key = newKey();
      consumers[id].keyHash = hashKey(key);
      save(consumers);
      if (json) { console.log(JSON.stringify({ id, key }, null, 2)); return; }
      console.log(`new key for ${id} (the old key and its grants stop working now):`);
      console.log(`  ${key}`);
      return;
    }
    case 'remove': {
      const id = rest[0];
      const consumers = load();
      if (!id || !consumers[id]) fail(`no consumer ${id ?? ''}`, EXIT.NOT_FOUND);
      delete consumers[id];
      save(consumers);
      if (json) { console.log(JSON.stringify({ id, removed: true })); return; }
      console.log(`removed ${id}; its grants end now`);
      return;
    }
    default:
      fail(HELP);
  }
}
