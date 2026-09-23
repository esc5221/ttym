import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import process from 'node:process';
import { HOME_DIR, readOption } from './common.js';
import { Steps, checkTarget } from './remote-steps.js';
import { addAllowHost, mintLink, printQr, remoteStatus } from './remote.js';

/**
 * ttym remote cloudflare — Cloudflare Tunnel + Access through the API.
 *
 * A remotely-managed tunnel (config_src "cloudflare") needs no cert.pem, no
 * `cloudflared tunnel login` browser dance and no YAML: one API token creates
 * the tunnel, its ingress, the DNS record and the Access app, and the machine
 * keeps only a connector token. Each step reads first and changes only what
 * differs, so a re-run after a fix picks up where the last one stopped.
 *
 * Token permissions: Account · Cloudflare Tunnel · Edit, Account · Access:
 * Apps and Policies · Edit, Zone · DNS · Edit.
 */
const API = 'https://api.cloudflare.com/client/v4';
const TOKEN_FILE = resolve(HOME_DIR, 'cloudflare-token');

interface CfResponse<T> { success: boolean; result: T; errors?: Array<{ code: number; message: string }> }

function readToken(args: string[]): { token: string | null; source: string } {
  const envName = readOption(args, '--token-env');
  if (envName) return { token: process.env[envName] || null, source: `$${envName}` };
  if (process.env.CLOUDFLARE_API_TOKEN) return { token: process.env.CLOUDFLARE_API_TOKEN, source: '$CLOUDFLARE_API_TOKEN' };
  try { return { token: readFileSync(TOKEN_FILE, 'utf8').trim() || null, source: TOKEN_FILE }; } catch {}
  return { token: null, source: '' };
}

export async function cmdRemoteCloudflare(port: number, args: string[], json: boolean) {
  const dryRun = args.includes('--dry-run');
  const replaceDns = args.includes('--replace-dns');
  const host = readOption(args, '--host')?.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '') ?? null;
  const email = readOption(args, '--email');
  const steps = new Steps(json);
  const done = (extra: Record<string, unknown> = {}, note?: string) => steps.finish({ path: 'cloudflare', host, dryRun, ...extra }, note);

  if (!host) {
    steps.add('args', 'fail', 'which hostname should serve ttym?', { fix: 'ttym remote cloudflare --host ttym.example.com --email you@example.com' });
    done();
  }

  const { token, source } = readToken(args);
  if (!token) {
    steps.add('token', 'human', 'no Cloudflare API token — create one with: Account·Cloudflare Tunnel·Edit, Account·Access: Apps and Policies·Edit, Zone·DNS·Edit', {
      url: 'https://dash.cloudflare.com/profile/api-tokens',
      fix: `export CLOUDFLARE_API_TOKEN=…   or save it to ${TOKEN_FILE} (chmod 600)`,
    });
    done();
  }

  const cf = async <T>(method: string, path: string, body?: unknown): Promise<CfResponse<T>> => {
    const res = await fetch(`${API}${path}`, {
      method, signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    try { return await res.json() as CfResponse<T>; } catch { return { success: false, result: null as T, errors: [{ code: res.status, message: res.statusText }] }; }
  };
  const errText = (r: CfResponse<unknown>) => (r.errors ?? []).map((e) => `${e.code} ${e.message}`).join('; ') || 'unknown error';

  // ── zone: the longest suffix of the host that is a zone this token can see
  const labels = host!.split('.');
  let zone: { id: string; name: string; account: { id: string } } | null = null;
  const zoneArg = readOption(args, '--zone');
  for (let i = 0; i < labels.length - 1 && !zone; i++) {
    const name = zoneArg ?? labels.slice(i).join('.');
    const r = await cf<Array<{ id: string; name: string; account: { id: string } }>>('GET', `/zones?name=${encodeURIComponent(name)}`);
    if (!r.success) { steps.add('token', 'fail', `token rejected (${source}): ${errText(r)}`, { url: 'https://dash.cloudflare.com/profile/api-tokens' }); done(); }
    if (r.result?.length) zone = r.result[0]!;
    if (zoneArg) break;
  }
  steps.add('token', 'ok', `API token from ${source}`);
  if (!zone) {
    steps.add('zone', 'fail', `no zone for ${host} visible to this token — is the domain on Cloudflare, and does the token include it?`, { fix: 'add Zone·DNS·Edit for that zone to the token, or pass --zone <domain>' });
    done();
  }
  const acc = zone!.account.id;
  steps.add('zone', 'ok', `${zone!.name}`);

  // ── Zero Trust organization: Access needs it, and creating it asks for a team name and plan in the dashboard
  // Reading the organization needs its own permission, which the token may lack (code 10000) even
  // when Zero Trust is live; listing Access apps then answers the same question.
  const isAuthErr = (r: CfResponse<unknown>) => (r.errors ?? []).some((e) => e.code === 10000);
  const org = await cf<{ auth_domain?: string }>('GET', `/accounts/${acc}/access/organizations`);
  if (org.success && org.result?.auth_domain) steps.add('zerotrust', 'ok', org.result.auth_domain);
  else {
    const probe = await cf<unknown[]>('GET', `/accounts/${acc}/access/apps`);
    if (probe.success) steps.add('zerotrust', 'ok', 'Zero Trust active');
    else if (isAuthErr(probe)) {
      steps.add('zerotrust', 'fail', 'the token cannot read Access', { fix: 'add Account·Access: Apps and Policies·Edit to the token', url: 'https://dash.cloudflare.com/profile/api-tokens' });
      done();
    } else {
      steps.add('zerotrust', 'human', `Zero Trust is not set up on this account (${errText(probe)}) — open it once, pick a team name and the Free plan`, { url: 'https://one.dash.cloudflare.com/' });
      done();
    }
  }

  // ── DNS first (read only): a host already routed elsewhere stops here, before anything is created
  const recs = await cf<Array<{ id: string; type: string; content: string; proxied: boolean }>>('GET', `/zones/${zone!.id}/dns_records?name=${encodeURIComponent(host!)}`);
  if (!recs.success) { steps.add('dns', 'fail', `cannot read DNS: ${errText(recs)}`, { fix: 'add Zone·DNS·Edit to the token' }); done(); }
  const rec = recs.result?.[0];

  // ── tunnel
  const tunnelName = `ttym-${host!.replace(/[^a-z0-9-]/g, '-').replace(/^ttym-/, '')}`;
  const found = await cf<Array<{ id: string; name: string }>>('GET', `/accounts/${acc}/cfd_tunnel?name=${encodeURIComponent(tunnelName)}&is_deleted=false`);
  if (!found.success) { steps.add('tunnel', 'fail', `cannot list tunnels: ${errText(found)}`, { fix: 'add Account·Cloudflare Tunnel·Edit to the token' }); done(); }
  let tunnelId = found.result?.[0]?.id ?? null;
  const pointsElsewhere = rec && !(rec.type === 'CNAME' && tunnelId && rec.content === `${tunnelId}.cfargotunnel.com`);
  if (pointsElsewhere && !replaceDns) {
    const other = rec!.content.endsWith('.cfargotunnel.com') ? `another tunnel (${rec!.content.split('.')[0]!.slice(0, 8)}), not managed by ttym` : `${rec!.type} ${rec!.content}`;
    steps.add('dns', 'fail', `${host} already points to ${other}`, {
      fix: `keep it: ttym remote allow-host ${host} && ttym remote doctor   ·   or move it here: add --replace-dns`,
    });
    done();
  }
  if (tunnelId) steps.add('tunnel', 'ok', `${tunnelName} (${tunnelId.slice(0, 8)})`);
  else if (dryRun) steps.add('tunnel', 'planned', `create ${tunnelName} (remotely managed)`);
  else {
    const made = await cf<{ id: string }>('POST', `/accounts/${acc}/cfd_tunnel`, { name: tunnelName, config_src: 'cloudflare' });
    if (!made.success) { steps.add('tunnel', 'fail', `create failed: ${errText(made)}`); done(); }
    tunnelId = made.result.id;
    steps.add('tunnel', 'changed', `${tunnelName} (${tunnelId.slice(0, 8)})`);
  }

  // ── ingress: our hostname → 127.0.0.1:<port>, other rules kept, catch-all last
  const service = `http://127.0.0.1:${port}`;
  if (tunnelId) {
    type Rule = { hostname?: string; service: string; path?: string };
    const cfg = await cf<{ config?: { ingress?: Rule[] } }>('GET', `/accounts/${acc}/cfd_tunnel/${tunnelId}/configurations`);
    const rules = cfg.result?.config?.ingress ?? [];
    const mine = rules.find((r) => r.hostname === host);
    if (mine?.service === service) steps.add('ingress', 'ok', `${host} → ${service}`);
    else if (dryRun) steps.add('ingress', 'planned', `${host} → ${service}`);
    else {
      const others = rules.filter((r) => r.hostname && r.hostname !== host);
      const put = await cf('PUT', `/accounts/${acc}/cfd_tunnel/${tunnelId}/configurations`, {
        config: { ingress: [...others, { hostname: host, service }, { service: 'http_status:404' }] },
      });
      if (!put.success) { steps.add('ingress', 'fail', `update failed: ${errText(put)}`); done(); }
      steps.add('ingress', 'changed', `${host} → ${service}`);
    }
  } else steps.add('ingress', 'planned', `${host} → ${service}`);

  // ── DNS: a proxied CNAME to the tunnel. An existing record elsewhere is reported, never silently repointed
  const want = tunnelId ? `${tunnelId}.cfargotunnel.com` : '<tunnel>.cfargotunnel.com';
  if (rec && rec.type === 'CNAME' && rec.content === want && rec.proxied) steps.add('dns', 'ok', `${host} CNAME → ${want}`);
  else if (dryRun) steps.add('dns', 'planned', `${host} CNAME → ${want} (proxied)`);
  else {
    const body = { type: 'CNAME', name: host, content: want, proxied: true, comment: 'ttym remote cloudflare' };
    const r = rec ? await cf('PUT', `/zones/${zone!.id}/dns_records/${rec.id}`, body) : await cf('POST', `/zones/${zone!.id}/dns_records`, body);
    if (!r.success) { steps.add('dns', 'fail', `DNS write failed: ${errText(r)}`); done(); }
    steps.add('dns', 'changed', `${host} CNAME → ${want}`);
  }

  // ── Access: an app covering the host must exist before the connector goes live
  type App = { id: string; name: string; domain?: string; destinations?: Array<{ uri?: string }>; policies?: unknown[] };
  const apps = await cf<App[]>('GET', `/accounts/${acc}/access/apps`);
  if (!apps.success) { steps.add('access', 'fail', `cannot list Access apps: ${errText(apps)}`, { fix: 'add Account·Access: Apps and Policies·Edit to the token' }); done(); }
  const covers = (a: App) => a.domain === host || (a.destinations ?? []).some((d) => d.uri === host);
  const app = (apps.result ?? []).find(covers);
  if (app) {
    const n = app.policies?.length ?? 0;
    if (n) steps.add('access', 'ok', `"${app.name}" covers ${host} (${n} polic${n === 1 ? 'y' : 'ies'})`);
    else { steps.add('access', 'fail', `"${app.name}" covers ${host} but has no policy — nobody can log in`, { url: 'https://one.dash.cloudflare.com/' }); done(); }
  } else if (!email) {
    steps.add('access', 'fail', `no Access app covers ${host}; say who may log in`, { fix: `ttym remote cloudflare --host ${host} --email you@example.com` });
    done();
  } else if (dryRun) steps.add('access', 'planned', `app "ttym ${host}", allow ${email} (one-time PIN by email)`);
  else {
    const policy = { name: 'ttym owner', decision: 'allow', include: [{ email: { email } }] };
    const made = await cf<App>('POST', `/accounts/${acc}/access/apps`, {
      name: `ttym ${host}`, domain: host, type: 'self_hosted', session_duration: '720h', app_launcher_visible: false, policies: [policy],
    });
    if (!made.success) { steps.add('access', 'fail', `create failed: ${errText(made)}`); done(); }
    const check = await cf<App>('GET', `/accounts/${acc}/access/apps/${made.result.id}`);
    if (!(check.result?.policies?.length)) {
      // Older accounts only take app-scoped policies through their own endpoint.
      const p = await cf('POST', `/accounts/${acc}/access/apps/${made.result.id}/policies`, { ...policy, precedence: 1 });
      if (!p.success) { steps.add('access', 'fail', `app created but its policy failed: ${errText(p)} — the host stays locked until a policy exists`, { url: 'https://one.dash.cloudflare.com/' }); done(); }
    }
    steps.add('access', 'changed', `app "ttym ${host}", allow ${email}`);
  }

  // ── connector: cloudflared on this machine, under launchd/systemd, holding only the tunnel token
  const cloudflared = which('cloudflared');
  if (!cloudflared) {
    steps.add('connector', 'fail', 'cloudflared is not installed', { fix: process.platform === 'darwin' ? 'brew install cloudflared' : 'see https://pkg.cloudflare.com/' });
    done();
  }
  if (!tunnelId) steps.add('connector', 'planned', `run ${cloudflared} for the tunnel under ${process.platform === 'darwin' ? 'launchd' : 'systemd'}`);
  else {
    const conns = async () => ((await cf<{ connections?: unknown[] }>('GET', `/accounts/${acc}/cfd_tunnel/${tunnelId}`)).result?.connections ?? []).length;
    if (await conns() > 0) steps.add('connector', 'ok', 'connected');
    else if (dryRun) steps.add('connector', 'planned', `install ${serviceName(tunnelId)} (${cloudflared})`);
    else {
      const tok = await cf<string>('GET', `/accounts/${acc}/cfd_tunnel/${tunnelId}/token`);
      if (!tok.success || typeof tok.result !== 'string') { steps.add('connector', 'fail', `cannot fetch the tunnel token: ${errText(tok)}`); done(); }
      installConnector(cloudflared!, tunnelId, tok.result);
      const t0 = Date.now();
      while (Date.now() - t0 < 30_000 && await conns() === 0) await new Promise((r) => setTimeout(r, 2000));
      if (await conns() > 0) steps.add('connector', 'changed', `${serviceName(tunnelId)} connected`);
      else { steps.add('connector', 'fail', `${serviceName(tunnelId)} installed but not connected after 30s`, { fix: `tail ${resolve(HOME_DIR, 'cloudflared.log')}` }); done(); }
    }
  }

  const allowed = (await remoteStatus(port)).allowHosts.includes(host!);
  if (allowed) steps.add('allow-host', 'ok', host!);
  else if (dryRun) steps.add('allow-host', 'planned', host!);
  else { await addAllowHost(port, host!); steps.add('allow-host', 'changed', host!); }

  if (dryRun) done();

  for (const c of await checkTarget(`https://${host}`, { retryMs: 60_000, port })) steps.add('doctor', c.status, c.detail, c.fix ? { fix: c.fix } : {});
  if (steps.blocked) done();

  const l = await mintLink(port, host!);
  steps.add('link', 'ok', 'login link minted (one use, 10 min)');
  const next = `Open the link on the phone: Cloudflare Access asks for ${email ?? 'the allowed email'} and mails a one-time PIN, then ttym signs the browser in.`;
  if (!json) { console.log(`\n${next}\n\n  ${l.url}\n`); await printQr(l.url); }
  done({ url: `https://${host}`, link: l.url, linkExpiresAt: l.expiresAt, next });
}

function which(bin: string): string | null {
  try { return execFileSync('/bin/sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).trim() || null; } catch { return null; }
}

const serviceName = (tunnelId: string) => process.platform === 'darwin' ? `com.ttym.cloudflared.${tunnelId.slice(0, 8)}` : `ttym-cloudflared-${tunnelId.slice(0, 8)}.service`;

/** Token goes to a 0600 file and the job reads it with --token-file, so it never sits in a plist or `ps`. */
function installConnector(cloudflared: string, tunnelId: string, token: string) {
  mkdirSync(HOME_DIR, { recursive: true });
  const tokenPath = resolve(HOME_DIR, `cloudflared-${tunnelId.slice(0, 8)}.token`);
  writeFileSync(tokenPath, token, { mode: 0o600 });
  chmodSync(tokenPath, 0o600);
  const logPath = resolve(HOME_DIR, 'cloudflared.log');
  const argv = [cloudflared, 'tunnel', '--no-autoupdate', 'run', '--token-file', tokenPath];
  const name = serviceName(tunnelId);
  if (process.platform === 'darwin') {
    const plist = resolve(homedir(), 'Library/LaunchAgents', `${name}.plist`);
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${name}</string>
  <key>ProgramArguments</key>
  <array>
${argv.map((a) => `    <string>${a}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${logPath}</string>
  <key>StandardErrorPath</key><string>${logPath}</string>
</dict>
</plist>
`);
    const gui = `gui/${process.getuid?.() ?? 501}`;
    try { execFileSync('launchctl', ['bootout', `${gui}/${name}`], { stdio: 'ignore' }); } catch {}
    execFileSync('launchctl', ['bootstrap', gui, plist], { stdio: 'ignore' });
    return;
  }
  const dir = resolve(homedir(), '.config/systemd/user');
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, name), `[Unit]
Description=ttym Cloudflare tunnel connector
After=network-online.target

[Service]
ExecStart=${argv.join(' ')}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`);
  execFileSync('systemctl', ['--user', 'daemon-reload']);
  execFileSync('systemctl', ['--user', 'enable', '--now', name]);
}
