import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
 *
 * install.sh 설치본(install.json kind=release)은 빌드 대신 GitHub Release의
 * tarball을 받는다. 웹 앱·훅 스크립트가 dist 밖에 있으므로 스왑 단위가 dist가
 * 아니라 설치 폴더 전체다: <root>.next → <root>, <root> → <root>.prev.
 * 폴더 경로는 그대로라 launchd plist·에이전트 훅의 절대경로가 계속 맞는다.
 */

const ROOT = resolve(dirname(SERVER_JS), '..');
const DIST = resolve(ROOT, 'dist');
const DIST_NEXT = resolve(ROOT, 'dist.next');
const DIST_PREV = resolve(ROOT, 'dist.prev');
const ROOT_NEXT = `${ROOT}.next`;
const ROOT_PREV = `${ROOT}.prev`;

interface ReleaseInstall { kind: 'release'; repo: string; version: string; platform: string }

function readReleaseInstall(): ReleaseInstall | null {
  try {
    const raw = JSON.parse(readFileSync(resolve(ROOT, 'install.json'), 'utf8'));
    if (raw?.kind === 'release' && raw.repo && raw.platform) return raw as ReleaseInstall;
  } catch {}
  return null;
}

/** The latest tag, read from the /releases/latest redirect — no API call, no rate limit. */
async function latestTag(repo: string): Promise<string> {
  const res = await fetch(`https://github.com/${repo}/releases/latest`, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  const tag = res.headers.get('location')?.match(/\/releases\/tag\/([^/?#]+)$/)?.[1];
  if (!tag) throw new Error(`no release found for ${repo} (HTTP ${res.status})`);
  return decodeURIComponent(tag);
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`download failed: ${url} (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

function swapRoot(from: string, to: string) {
  rmSync(to, { recursive: true, force: true });
  renameSync(ROOT, to);
  renameSync(from, ROOT);
}

/**
 * Release install: fetch ttym-<platform>.tar.gz (+ .sha256), unpack beside the
 * install folder, swap by rename, restart, health-check, roll back on failure.
 * TTYM_UPGRADE_TARBALL=<file> installs a local tarball instead (testing).
 */
async function upgradeRelease(rel: ReleaseInstall, port: number) {
  const before = await serverVersion(port);
  const local = process.env.TTYM_UPGRADE_TARBALL;
  const tag = local ? null : await latestTag(rel.repo);

  if (hasFlag('--check')) {
    console.log(`installed: ${PRODUCT_VERSION} (release, ${rel.platform}) → ${ROOT}`);
    console.log(`latest:    ${tag ?? '(local tarball)'}`);
    console.log(before ? `server:    ${before.version ?? '<pre-0.3>'} (api v${before.apiVersion})` : 'server:    not running');
    return;
  }
  if (tag && tag === `v${PRODUCT_VERSION}` && !hasFlag('--force')) {
    console.log(`already on the latest release (${tag}). --force reinstalls it.`);
    return;
  }

  const asset = `ttym-${rel.platform}.tar.gz`;
  let tarball: Buffer;
  if (local) {
    tarball = readFileSync(local);
    console.log(`installing ${local} …`);
  } else {
    const base = `https://github.com/${rel.repo}/releases/download/${tag}`;
    console.log(`downloading ${tag} ${asset} …`);
    tarball = await download(`${base}/${asset}`);
    const want = (await download(`${base}/${asset}.sha256`)).toString('utf8').trim().split(/\s+/)[0];
    const got = createHash('sha256').update(tarball).digest('hex');
    if (want !== got) { console.error(`checksum mismatch for ${asset} (expected ${want}, got ${got})`); process.exit(EXIT.FAIL); }
    console.log('checksum ok');
  }

  const tmp = mkdtempSync(resolve(tmpdir(), 'ttym-upgrade-'));
  try {
    writeFileSync(resolve(tmp, asset), tarball);
    rmSync(ROOT_NEXT, { recursive: true, force: true });
    mkdirSync(ROOT_NEXT, { recursive: true });
    execFileSync('tar', ['-xzf', resolve(tmp, asset), '-C', ROOT_NEXT], { stdio: 'inherit' });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  if (!existsSync(resolve(ROOT_NEXT, 'dist', 'ttym-server.js')) || !existsSync(resolve(ROOT_NEXT, 'install.json'))) {
    rmSync(ROOT_NEXT, { recursive: true, force: true });
    console.error(`${asset} is missing files — nothing changed`);
    process.exit(EXIT.FAIL);
  }

  // rename만 — 실행 중인 서버·holder는 자기 inode를 계속 쓴다.
  swapRoot(ROOT_NEXT, ROOT_PREV);
  const info = await restartAndCheck(port);
  if (!info) {
    console.error('new server failed health check — rolling back');
    swapRoot(ROOT_PREV, ROOT_NEXT);
    const back = await restartAndCheck(port);
    console.error(back ? 'rollback ok — previous server is running' : 'rollback restart also failed — see ttym log');
    process.exit(EXIT.FAIL);
  }
  const sessions = await (async () => {
    try { return ((await (await fetch(`${apiBase(port)}/api/sessions`)).json()) as unknown[]).length; } catch { return '?'; }
  })();
  console.log(`upgraded: ${before?.version ?? '<pre-0.3>'} → ${info.version ?? '?'} (api v${info.apiVersion}) · ${sessions} sessions alive`);
}

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
  const release = readReleaseInstall();

  if (release && hasFlag('--rollback')) {
    if (!existsSync(ROOT_PREV)) {
      console.error(`no ${ROOT_PREV} — nothing to roll back to`);
      process.exit(EXIT.NOT_FOUND);
    }
    swapRoot(ROOT_PREV, `${ROOT}.rolledback`);
    const info = await restartAndCheck(port);
    if (!info) { console.error('rolled back the files, but the server did not come up'); process.exit(EXIT.FAIL); }
    console.log(`rolled back → server ${info.version ?? '?'} (api v${info.apiVersion})`);
    return;
  }
  if (release) return upgradeRelease(release, port);

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
    console.error('this is an npm install — upgrade with: npm i -g ttym@latest && ttym restart   (sessions survive the restart)');
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
