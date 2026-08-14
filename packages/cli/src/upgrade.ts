import { execFileSync } from 'node:child_process';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { EXIT, SERVER_JS, apiBase, getPort, hasFlag, printOutput } from './common.js';
import { API_VERSION, MIN_API_VERSION, PRODUCT_VERSION } from '@ttym/protocol';
import { readServiceMarker, serviceRestart } from './service.js';
import { cmdStop, ensureServerRunning } from './lifecycle.js';

/**
 * ttym upgrade — 세션은 살아있는 채로 서버·CLI만 교체한다.
 *
 * 규율은 협의회 그대로: 제자리 덮어쓰기 금지, rename만. 실행 중인 holder와
 * 서버는 자기 inode를 계속 쓰고(POSIX), 새 프로세스만 새 바이너리를 받는다.
 * dist.prev 한 세대를 보존해 --rollback이 성립한다.
 *
 *   build → dist.next   (소스 체크아웃에서만; npm 설치본은 npm이 교체를 대신)
 *   dist → dist.prev, dist.next → dist   (rename 스왑)
 *   restart (감독 중이면 위임) → 헬스체크 → 실패 시 자동 롤백
 */

const ROOT = resolve(dirname(SERVER_JS), '..');
const DIST = resolve(ROOT, 'dist');
const DIST_NEXT = resolve(ROOT, 'dist.next');
const DIST_PREV = resolve(ROOT, 'dist.prev');

async function serverVersion(port: number): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${apiBase(port)}/api/version`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) return await res.json() as Record<string, unknown>;
  } catch {}
  return null;
}

async function restartAndCheck(port: number): Promise<Record<string, unknown> | null> {
  if (readServiceMarker()) {
    if (!(await serviceRestart())) return null;
  } else {
    try { cmdStop(); } catch {}
    await ensureServerRunning(port);
  }
  const t0 = Date.now();
  while (Date.now() - t0 < 30_000) {
    const info = await serverVersion(port);
    if (info) return info;
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

export async function cmdVersion() {
  const port = getPort();
  const server = await serverVersion(port);
  const out = {
    version: PRODUCT_VERSION,
    apiVersion: API_VERSION,
    minApiVersion: MIN_API_VERSION,
    node: process.version,
    dist: DIST,
    server: server ? { version: server.version ?? null, apiVersion: server.apiVersion ?? null, safeMode: server.safeMode ?? false } : null,
  };
  if (hasFlag('--json')) return printOutput(out, true);
  console.log(`ttym ${out.version} (api v${API_VERSION}, node ${process.version})`);
  console.log(server
    ? `server: ${server.version ?? '<pre-0.3>'} (api v${server.apiVersion})${server.safeMode ? ' — SAFE MODE' : ''}`
    : 'server: not running');
}

export async function cmdUpgrade() {
  const port = getPort();
  const buildScript = resolve(ROOT, 'scripts', 'build.sh');

  if (hasFlag('--rollback')) {
    if (!existsSync(DIST_PREV)) {
      console.error('no dist.prev — nothing to roll back to');
      process.exit(EXIT.NOT_FOUND);
    }
    const stash = resolve(ROOT, 'dist.rolledback');
    rmSync(stash, { recursive: true, force: true });
    renameSync(DIST, stash);
    renameSync(DIST_PREV, DIST);
    const info = await restartAndCheck(port);
    if (!info) { console.error('rolled back the files, but the server did not come up'); process.exit(EXIT.FAIL); }
    console.log(`rolled back → server ${info.version ?? '?'} (api v${info.apiVersion})`);
    return;
  }

  const before = await serverVersion(port);
  if (hasFlag('--check')) {
    console.log(`cli:    ${PRODUCT_VERSION} (api v${API_VERSION})`);
    console.log(before
      ? `server: ${before.version ?? '<pre-0.3>'} (api v${before.apiVersion})`
      : 'server: not running');
    return;
  }

  if (!existsSync(buildScript)) {
    console.error('upgrade needs a source checkout (scripts/build.sh) — npm installs upgrade via npm itself');
    process.exit(EXIT.FAIL);
  }

  console.log('building into dist.next …');
  rmSync(DIST_NEXT, { recursive: true, force: true });
  execFileSync('bash', [buildScript], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, TTYM_DIST: DIST_NEXT } });

  // rename만 — 실행 중인 서버·holder는 자기 inode를 계속 쓴다.
  rmSync(DIST_PREV, { recursive: true, force: true });
  renameSync(DIST, DIST_PREV);
  renameSync(DIST_NEXT, DIST);

  const info = await restartAndCheck(port);
  if (!info) {
    console.error('new server failed health check — rolling back');
    renameSync(DIST, DIST_NEXT);
    renameSync(DIST_PREV, DIST);
    const back = await restartAndCheck(port);
    console.error(back ? 'rollback ok — previous server is running' : 'rollback restart also failed — see ttym log');
    process.exit(EXIT.FAIL);
  }
  const sessions = await (async () => {
    try { return ((await (await fetch(`${apiBase(port)}/api/sessions`)).json()) as unknown[]).length; } catch { return '?'; }
  })();
  console.log(`upgraded: ${before?.version ?? '<pre-0.3>'} → ${info.version ?? '?'} (api v${info.apiVersion}) · ${sessions} sessions alive`);
}
