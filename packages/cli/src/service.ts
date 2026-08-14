import { execFileSync, execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import process from 'node:process';
import { EXIT, HOME_DIR, LOG_FILE, SERVER_JS, HOLDER_BIN, PID_FILE, getPort, apiBase, hasFlag, printOutput, readPid } from './common.js';

/**
 * ttym service — 상주는 OS 감독자(launchd/systemd)에게 맡기고, 사용자에겐
 * 동사 세 개만 보인다: install / uninstall / status.
 *
 * plist/unit은 정적 출하가 아니라 설치 시점에 생성한다 — 경로·포트·노드가
 * 그 기기의 사실이다. 등록 사실은 ~/.ttym/service.json 마커에 남아,
 * restart가 "launchd가 살렸나?" 추측 대신 사실로 위임을 판단한다.
 */

const SERVICE_MARKER = resolve(HOME_DIR, 'service.json');
const LABEL = process.env.TTYM_SERVICE_LABEL || 'com.ttym.server';

export interface ServiceMarker {
  kind: 'launchd' | 'systemd';
  label: string;
  path: string;
  port: number;
}

export function readServiceMarker(): ServiceMarker | null {
  try {
    const raw = JSON.parse(readFileSync(SERVICE_MARKER, 'utf8'));
    if (raw && typeof raw === 'object' && raw.kind && raw.label) return raw as ServiceMarker;
  } catch {}
  return null;
}

/** 순수 렌더러 — 테스트가 여기를 본다. KeepAlive + 10초 스로틀(크래시 루프 방어). */
export function renderLaunchdPlist(opts: {
  label: string; nodePath: string; serverJs: string; holderBin: string;
  port: number; bind?: string | null; logPath: string; homeDir: string;
}): string {
  const env: Record<string, string> = {
    PORT: String(opts.port),
    TTYM_HOLDER_BIN: opts.holderBin,
    TTYM_HOME: opts.homeDir,
  };
  if (opts.bind) env.TTYM_BIND = opts.bind;
  const envXml = Object.entries(env)
    .map(([k, v]) => `    <key>${k}</key><string>${v}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${opts.label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${opts.nodePath}</string>
    <string>${opts.serverJs}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${opts.logPath}</string>
  <key>StandardErrorPath</key><string>${opts.logPath}</string>
</dict>
</plist>
`;
}

export function renderSystemdUnit(opts: {
  nodePath: string; serverJs: string; holderBin: string;
  port: number; bind?: string | null; homeDir: string;
}): string {
  const envLines = [
    `Environment=PORT=${opts.port}`,
    `Environment=TTYM_HOLDER_BIN=${opts.holderBin}`,
    `Environment=TTYM_HOME=${opts.homeDir}`,
    ...(opts.bind ? [`Environment=TTYM_BIND=${opts.bind}`] : []),
  ].join('\n');
  return `[Unit]
Description=ttym server

[Service]
ExecStart=${opts.nodePath} ${opts.serverJs}
Restart=on-failure
RestartSec=10
${envLines}

[Install]
WantedBy=default.target
`;
}

function launchctl(args: string[], opts: { allowFail?: boolean } = {}): string {
  try {
    return execFileSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (opts.allowFail) return '';
    throw error;
  }
}

function gui(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

async function serverUp(port: number): Promise<boolean> {
  try {
    const res = await fetch(`${apiBase(port)}/api/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch { return false; }
}

async function installLaunchd(port: number, bind: string | null) {
  const plistPath = resolve(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

  // 기존의 감독 없는 서버가 이 포트를 쥐고 있으면 인계한다. 다른 감독자
  // (수제 launchd 등)가 쥐고 있으면 KeepAlive끼리 포트 싸움이 나므로 거부.
  if (await serverUp(port)) {
    const pid = readPid();
    if (pid) {
      try { process.kill(pid, 'SIGTERM'); } catch {}
      const t0 = Date.now();
      while (Date.now() - t0 < 60_000 && await serverUp(port)) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    if (await serverUp(port)) {
      console.error(`port ${port} is served by a process this CLI does not supervise.`);
      console.error('another service manager may own it (a hand-made launchd label?) — remove that first.');
      process.exit(EXIT.FAIL);
    }
    console.error('took over the unsupervised server (holders keep every session)');
  }

  mkdirSync(resolve(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(plistPath, renderLaunchdPlist({
    label: LABEL, nodePath: process.execPath, serverJs: SERVER_JS,
    holderBin: process.env.TTYM_HOLDER_BIN || HOLDER_BIN,
    port, bind, logPath: LOG_FILE, homeDir: HOME_DIR,
  }));
  launchctl(['bootout', gui(), plistPath], { allowFail: true });
  launchctl(['bootstrap', gui(), plistPath]);

  const marker: ServiceMarker = { kind: 'launchd', label: LABEL, path: plistPath, port };
  mkdirSync(HOME_DIR, { recursive: true });
  writeFileSync(SERVICE_MARKER, JSON.stringify(marker, null, 2) + '\n');

  const t0 = Date.now();
  while (Date.now() - t0 < 20_000) {
    if (await serverUp(port)) {
      console.log(`ttym is now supervised (${LABEL}) — boots at login, restarts on crash`);
      console.log(`sessions survive either way: holders outlive the server`);
      return;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.error(`service registered but the server did not come up — see ${LOG_FILE}`);
  process.exit(EXIT.FAIL);
}

async function installSystemd(port: number, bind: string | null) {
  const unitDir = resolve(homedir(), '.config', 'systemd', 'user');
  const unitPath = resolve(unitDir, 'ttym.service');
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(unitPath, renderSystemdUnit({
    nodePath: process.execPath, serverJs: SERVER_JS,
    holderBin: process.env.TTYM_HOLDER_BIN || HOLDER_BIN,
    port, bind, homeDir: HOME_DIR,
  }));
  execFileSync('systemctl', ['--user', 'daemon-reload']);
  execFileSync('systemctl', ['--user', 'enable', '--now', 'ttym.service']);
  const marker: ServiceMarker = { kind: 'systemd', label: 'ttym.service', path: unitPath, port };
  mkdirSync(HOME_DIR, { recursive: true });
  writeFileSync(SERVICE_MARKER, JSON.stringify(marker, null, 2) + '\n');
  console.log('ttym is now supervised (systemd --user) — restarts on crash');
  console.log('tip: `loginctl enable-linger` keeps it alive outside login sessions');
}

async function uninstall() {
  const marker = readServiceMarker();
  if (!marker) {
    console.error('no service marker — nothing installed by this CLI');
    process.exit(EXIT.NOT_FOUND);
  }
  if (marker.kind === 'launchd') {
    launchctl(['bootout', gui(), marker.path], { allowFail: true });
  } else {
    try { execFileSync('systemctl', ['--user', 'disable', '--now', 'ttym.service']); } catch {}
  }
  try { unlinkSync(marker.path); } catch {}
  try { unlinkSync(SERVICE_MARKER); } catch {}
  console.log('service removed. the server is stopped; holders keep every session alive');
  console.log('any entry verb (ttym <workspace>) will start an unsupervised server again');
}

async function status() {
  const marker = readServiceMarker();
  const port = marker?.port ?? getPort();
  const up = await serverUp(port);
  const out: Record<string, unknown> = {
    supervised: !!marker,
    kind: marker?.kind ?? null,
    label: marker?.label ?? null,
    path: marker?.path ?? null,
    port,
    running: up,
  };
  if (marker?.kind === 'launchd') {
    const dump = launchctl(['print', `${gui()}/${marker.label}`], { allowFail: true });
    const pid = dump.match(/pid = (\d+)/)?.[1];
    const lastExit = dump.match(/last exit code = ([^\n]+)/)?.[1]?.trim();
    out.pid = pid ? parseInt(pid, 10) : null;
    out.lastExit = lastExit ?? null;
  }
  if (up) {
    try {
      const version = await (await fetch(`${apiBase(port)}/api/version`)).json();
      out.apiVersion = (version as { apiVersion?: number }).apiVersion ?? null;
      const sessions = await (await fetch(`${apiBase(port)}/api/sessions`)).json();
      out.sessions = Array.isArray(sessions) ? sessions.length : null;
    } catch {}
  }
  if (hasFlag('--json')) return printOutput(out, true);
  console.log(`supervised: ${out.supervised ? `yes (${out.kind}, ${out.label})` : 'no'}`);
  console.log(`server:     ${up ? `running on ${port}` : 'not running'}${out.pid ? ` (pid ${out.pid})` : ''}`);
  if (out.lastExit && out.lastExit !== '0') console.log(`last exit:  ${out.lastExit}`);
  if (out.sessions !== undefined) console.log(`sessions:   ${out.sessions}`);
  process.exit(up || !marker ? EXIT.OK : EXIT.NO_SERVER);
}

export async function cmdService() {
  const sub = process.argv[3];
  const port = getPort();
  if (sub === 'install') {
    const bind = process.env.TTYM_BIND || null;
    if (process.platform === 'darwin') return installLaunchd(port, bind);
    if (process.platform === 'linux') return installSystemd(port, bind);
    console.error(`unsupported platform for service install: ${process.platform}`);
    process.exit(EXIT.FAIL);
  }
  if (sub === 'uninstall') return uninstall();
  if (sub === 'status') return status();
  console.error('usage: ttym service <install|uninstall|status> [--json]');
  process.exit(EXIT.USAGE);
}

/** restart가 부른다: 감독자에게 재기동을 위임하고 성공 여부를 돌려준다. */
export async function serviceRestart(): Promise<boolean> {
  const marker = readServiceMarker();
  if (!marker) return false;
  if (marker.kind === 'launchd') {
    try { execFileSync('launchctl', ['kickstart', '-k', `${gui()}/${marker.label}`]); } catch { return false; }
  } else {
    try { execFileSync('systemctl', ['--user', 'restart', 'ttym.service']); } catch { return false; }
  }
  const t0 = Date.now();
  while (Date.now() - t0 < 30_000) {
    if (await serverUp(marker.port)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}
