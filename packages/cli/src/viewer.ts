import { resolve } from 'node:path';
import process from 'node:process';
import { EXIT, getPort, fetchJson, fetchPost, fetchDelete, ensureCompatibleServer, hasFlag, readOption, printOutput, HOME_DIR } from './common.js';
import { resolveAddress } from './addresses.js';

/**
 * `ttym open` — macOS `open`, but the thing opens inside the pane you typed
 * it in. Paths resolve against this process's cwd, which *is* the pane's cwd
 * (the server's cwd means nothing here). URLs pass through.
 *
 *   ttym open report.html                 this pane, beside the terminal
 *   ttym open a.md b.csv --full           two tabs, workspace-wide
 *   ttym open out.html --to :reviewer     someone else's pane
 *   ttym open --root dist dist/app/x.html widen a file tab to dist/**
 *
 * `view close` and `view list` sit under `view` so the top level keeps its
 * lifecycle verbs (kill, stop, remove) unambiguous.
 */

function expandHome(p: string): string {
  return p.replace(/^~(?=\/|$)/, HOME_DIR.replace(/\/\.ttym$/, '') || process.env.HOME || '');
}

function isUrl(text: string): boolean {
  return /^https?:\/\//i.test(text);
}

function absolutize(target: string): string {
  if (isUrl(target)) return target;
  return resolve(expandHome(target));
}

/** The session a viewer command acts on: --to <addr>, else the pane we run in. */
async function resolveTargetSession(port: number, ownArgs: string[]): Promise<{ sessionId: number; label: string }> {
  const to = readOption(ownArgs, '--to');
  if (to) {
    const target = await resolveAddress(port, to);
    return { sessionId: target.sessionId, label: target.label };
  }
  const sid = process.env.TTYM_SESSION_ID;
  if (!sid || isNaN(parseInt(sid, 10))) {
    console.error('run inside a ttym pane, or say which one: --to <ws:name|:name|#id>');
    process.exit(EXIT.USAGE);
  }
  return { sessionId: parseInt(sid, 10), label: `#${sid}` };
}

/** Positional arguments only — option values (--to X, --root X) are not targets. */
function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--to' || a === '--root') { i++; continue; }
    if (a.startsWith('--')) continue;
    out.push(a);
  }
  return out;
}

export async function cmdOpen() {
  const args = process.argv.slice(3);
  const targets = positionals(args);
  if (targets.length === 0) {
    console.error('usage: ttym open <path|url>... [--to <addr>] [--full|--pane] [--root <dir>]');
    process.exit(EXIT.USAGE);
  }
  const port = getPort();
  await ensureCompatibleServer(port);
  const { sessionId, label } = await resolveTargetSession(port, args);
  // cwd rides along: a path that does not exist as typed is searched for by its tail under here.
  const body: Record<string, unknown> = { targets: targets.map(absolutize), cwd: process.cwd() };
  if (hasFlag('--full')) body.presentation = 'full';
  else if (hasFlag('--pane')) body.presentation = 'pane';
  const root = readOption(args, '--root');
  if (root) body.root = resolve(expandHome(root));

  const data = await fetchPost(port, `/api/sessions/${sessionId}/views`, body);
  if (!data || data.error) {
    console.error(`open failed: ${data?.error ?? 'no response'}`);
    process.exit(data?.error === 'not found' ? EXIT.NOT_FOUND : EXIT.FAIL);
  }
  const results: Array<{ target: string; ok: boolean; id?: string; rev?: number; error?: string; matched?: string }> = data.results ?? [];
  if (hasFlag('--json')) return printOutput({ session: label, sessionId, state: data.state, results }, true);
  let failed = 0;
  for (const r of results) {
    if (r.ok) console.log(`${r.id}  ${r.matched ?? r.target}${(r.rev ?? 1) > 1 ? `  (reloaded, rev ${r.rev})` : ''}  → ${label}${r.matched ? `\n   ↳ matched by tail; asked for ${r.target}` : ''}`);
    else { failed++; console.error(`!  ${r.target}: ${r.error}`); }
  }
  if (failed === results.length) process.exit(EXIT.NOT_FOUND);
}

export async function cmdView() {
  const sub = process.argv[3];
  const args = process.argv.slice(4);
  const port = getPort();
  const usage = () => {
    console.error('usage: ttym view list [--to <addr>]');
    console.error('       ttym view close (<path|url> | --id <vid> | --all) [--to <addr>]');
    process.exit(EXIT.USAGE);
  };
  if (sub !== 'list' && sub !== 'close') usage();
  await ensureCompatibleServer(port);
  const { sessionId, label } = await resolveTargetSession(port, args);

  if (sub === 'list') {
    const state = await fetchJson(port, `/api/sessions/${sessionId}/views`);
    if (hasFlag('--json')) return printOutput({ session: label, sessionId, state }, true);
    if (!state || !state.items?.length) { console.log(`no tabs in ${label}`); return; }
    for (const item of state.items) {
      const last = state.lastOpen?.itemId === item.id ? '*' : ' ';
      console.log(`${last} ${item.id}  ${item.renderer.padEnd(8)}  ${item.target}${item.rev > 1 ? `  (rev ${item.rev})` : ''}`);
    }
    return;
  }

  // close
  if (hasFlag('--all')) {
    await fetchDelete(port, `/api/sessions/${sessionId}/views`);
    if (hasFlag('--json')) return printOutput({ session: label, sessionId, state: null }, true);
    console.log(`closed all tabs in ${label}`);
    return;
  }
  let id = readOption(args, '--id');
  if (!id) {
    const target = positionals(args)[0];
    if (!target) usage();
    const state = await fetchJson(port, `/api/sessions/${sessionId}/views`);
    const wanted = absolutize(target!);
    const hit = state?.items?.find((item: { target: string }) => item.target === wanted || item.target === wanted.replace(/\/$/, ''))
      ?? state?.items?.find((item: { name: string }) => item.name === target);
    if (!hit) { console.error(`no such tab in ${label}: ${target}`); process.exit(EXIT.NOT_FOUND); }
    id = hit.id;
  }
  const data = await fetchDelete(port, `/api/sessions/${sessionId}/views/${encodeURIComponent(id!)}`);
  if (!data || data.error) { console.error(`close failed: ${data?.error ?? 'no response'}`); process.exit(EXIT.NOT_FOUND); }
  if (hasFlag('--json')) return printOutput({ session: label, sessionId, state: data.state }, true);
  console.log(`closed ${id} in ${label}`);
}
