import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { API_VERSION } from '@ttym/protocol';

/**
 * The CLI's whole contract in one pass: start a server, create a workspace,
 * add a member (which spawns a session), type into it, read the screen back,
 * remove it, stop the server.
 *
 * Runs the built artifact — dist/ttym is what everything actually executes —
 * so the suite needs a prior ./scripts/build.sh. Rust holder included, which
 * is why this cannot rebuild on the fly.
 */
const ROOT = resolve(__dirname, '../../..');
const CLI = join(ROOT, 'dist/ttym');
const HOLDER = join(ROOT, 'dist/ttym-holder');
const PORT = 17690 + (process.pid % 100);

const built = existsSync(CLI) && existsSync(HOLDER);
const suite = built ? describe : describe.skip;

let home = '';

function ttym(args: string[], opts: { canFail?: boolean } = {}): string {
  // The port travels via env only: --cmd consumes every following argv token,
  // so appending --port after it would hand the flag to the spawned shell.
  const r = spawnSync('node', [CLI, ...args], {
    env: { ...process.env, TTYM_HOME: home, PORT: String(PORT) },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (!opts.canFail && r.status !== 0) {
    throw new Error(`ttym ${args.join(' ')} → exit ${r.status}\n${r.stdout}\n${r.stderr}`);
  }
  return (r.stdout ?? '') + (r.stderr ?? '');
}

async function until(check: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('timed out');
}

const api = (path: string) =>
  fetch(`http://127.0.0.1:${PORT}${path}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);

suite('cli end to end', () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'ttym-e2e-'));
    ttym(['start']);
    await until(async () => (await api('/api/sessions')) !== null);
  }, 30_000);

  afterAll(() => {
    try { ttym(['stop'], { canFail: true }); } catch {}
    // Holders survive the server by design; this suite's must not outlive it.
    try {
      execFileSync('pkill', ['-f', home], { stdio: 'ignore' });
    } catch {}
    rmSync(home, { recursive: true, force: true });
  });

  it('reports its version to clients', async () => {
    const v = await api('/api/version');
    expect(v?.apiVersion).toBe(API_VERSION);
  });

  it('creates a workspace', () => {
    const out = ttym(['workspace', 'create', 'e2e', '--name', 'suite', '--json']);
    const ws = JSON.parse(out);
    expect(ws.project).toBe('e2e');
    expect(ws.name).toBe('suite');
  });

  it('adds a member, which spawns a live session', async () => {
    const out = ttym(['workspace', 'add', 'e2e/suite', '--name', 'sh', '--cmd', '/bin/zsh']);
    expect(out).toContain('added');
    await until(async () => ((await api('/api/sessions')) ?? []).length === 1);
  }, 20_000);

  it('sends input and reads it back from the screen', async () => {
    ttym(['workspace', 'send', 'e2e/suite', 'sh', '--', 'echo E2E_ROUNDTRIP\n']);
    await until(async () => {
      const sessions = (await api('/api/sessions')) ?? [];
      if (sessions.length === 0) return false;
      const screen = await api(`/api/sessions/${sessions[0].id}/screen`);
      return typeof screen?.screen === 'string' && screen.screen.includes('E2E_ROUNDTRIP');
    });
    // Poll the CLI path too: under load the render can land between the API
    // confirmation above and a single-shot read here.
    await until(() => ttym(['workspace', 'screen', 'e2e/suite', 'sh']).includes('E2E_ROUNDTRIP'));
  }, 20_000);

  it('structured output stays parseable', () => {
    const out = ttym(['workspace', 'info', 'e2e/suite', '--json']);
    const info = JSON.parse(out);
    expect(info.members?.length).toBe(1);
    expect(info.members[0].name).toBe('sh');
  });

  it('removes the member and its session', async () => {
    ttym(['workspace', 'remove', 'e2e/suite', 'sh']);
    await until(async () => ((await api('/api/sessions')) ?? []).length === 0);
  }, 20_000);

  it('speaks the colon grammar: new, split, send, screen', async () => {
    // Expand phase: these run beside the old workspace verbs, same server.
    const created = ttym(['new', 'g1', '--', '/bin/zsh']);
    expect(created).toContain('default:g1');
    await until(async () => ((await api('/api/sessions')) ?? []).length === 1);

    const split = ttym(['split', 'default:g1', 'g2', '--', '/bin/zsh']);
    expect(split).toContain(':g2');
    await until(async () => ((await api('/api/sessions')) ?? []).length === 2);

    ttym(['send', 'default:g2', '--', 'echo COLON_GRAMMAR\n']);
    await until(async () => (ttym(['screen', 'default:g2'])).includes('COLON_GRAMMAR'));

    // #id addresses the session directly — the only address an unattached
    // session would have (ADR-0001).
    const sessions = (await api('/api/sessions')) ?? [];
    const byId = ttym(['screen', `#${sessions[1].id}`]);
    expect(byId).toContain('COLON_GRAMMAR');

    // The split was a real split, not a rebuild: the workspace layout holds
    // both panes under one row.
    const workspaces = (await api('/api/workspaces')) ?? [];
    const ws = workspaces.find((w: { name: string }) => w.name === 'default');
    expect(ws.layout.type).toBe('split');
    expect(ws.layout.children.length).toBe(2);
  }, 30_000);

  it('reports a pending await instead of hanging on a hookless session', () => {
    const out = ttym(['await', 'default:g1', '--timeout', '1500', '--', 'hello'], { canFail: true });
    expect(out).toContain('timeout: still running');
  }, 20_000);

  it('restart keeps the sessions alive — the holder guarantee through the CLI', async () => {
    // g1/g2 are still running from the grammar tests above.
    const before = ((await api('/api/sessions')) ?? []).map((s: { id: number; pid: number }) => `${s.id}:${s.pid}`).sort();
    expect(before.length).toBe(2);

    ttym(['restart']);
    await until(async () => ((await api('/api/sessions')) ?? []).length === 2, 20_000);

    // Same session ids, same child pids: the PTYs never died.
    const after = ((await api('/api/sessions')) ?? []).map((s: { id: number; pid: number }) => `${s.id}:${s.pid}`).sort();
    expect(after).toEqual(before);

    // And the screen survived the swap.
    await until(() => ttym(['screen', 'default:g2']).includes('COLON_GRAMMAR'));
  }, 40_000);

  it('cleans up the grammar suite sessions', async () => {
    ttym(['workspace', 'remove', 'default/default', 'g1']);
    ttym(['workspace', 'remove', 'default/default', 'g2']);
    await until(async () => ((await api('/api/sessions')) ?? []).length === 0);
  }, 20_000);

  it('stops the server', async () => {
    ttym(['stop']);
    await until(async () => (await api('/api/sessions')) === null);
  });
});
