import process from 'node:process';
import { isIP } from 'node:net';
import { EXIT, getPort, hasFlag, fetchJson, fetchRequest, readOption } from './common.js';
import { ensureServerRunning } from './lifecycle.js';
import { Steps, rawStatus, checkTarget } from './remote-steps.js';
import { cmdRemoteTailscale } from './remote-tailscale.js';
import { cmdRemoteCloudflare } from './remote-cloudflare.js';
import { cmdRemoteTrust, cmdRemoteUntrust } from './remote-trust.js';

/**
 * ttym remote — reach this machine's ttym from another device.
 *
 * Agents: start with `ttym remote doctor --json`; it says what is set up and
 * which command to run next. Every command takes --json, never prompts, and is
 * safe to re-run. Setup commands take --dry-run.
 */
const HELP = `usage: ttym remote <command> [--json]

  Agents: run \`ttym remote doctor --json\` first — it reports state and the next command.
  Every command is non-interactive and safe to re-run; setup commands take --dry-run.

  tailscale [--ip]                   Recommended. tailscale serve → allow-host → login link → doctor
                                     --ip: http://<100.x>:<port>, no MagicDNS name or HTTPS certificate needed
  cloudflare --host <h> --email <e>  Cloudflare Tunnel + Access via the API (token: CLOUDFLARE_API_TOKEN,
             [--token-env NAME] [--replace-dns]   ~/.ttym/cloudflare-token, or --token-env)
  trust [tailscale | cloudflare --host <h> --email <e>]
                                     Let a verified Tailscale login / Access email open ttym without a link
  untrust tailscale|cloudflare|all
  link [--host <h>]                  One-time login URL (10 min) + QR — for paths without an identity (LAN, nginx)
  doctor [url...]                    Check local guards, bind, and that each remote URL demands a login
  status                             Bind address, allowed hosts, logged-in browsers
  allow-host <host> / disallow-host <host>
  sessions / revoke <id>|--all       Logged-in browsers; revoke signs them out
  off                                Forget all hosts and sign every browser out

  Guide: docs/remote-access.md`;

export async function cmdRemote() {
  const sub = process.argv[3];
  const args = process.argv.slice(4);
  const port = getPort();
  const json = hasFlag('--json');
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') { console.log(HELP); process.exit(sub ? EXIT.OK : EXIT.USAGE); }
  await ensureServerRunning(port);

  switch (sub) {
    case 'status': return status(port, json);
    case 'allow-host': return allowHost(port, args[0], json);
    case 'disallow-host': return disallowHost(port, args[0], json);
    case 'link': return link(port, readOption(args, '--host'), json);
    case 'sessions': return sessions(port, json);
    case 'revoke': return revoke(port, args.includes('--all') ? 'all' : args[0], json);
    case 'doctor': return doctor(port, args.filter((a) => !a.startsWith('--')), json);
    case 'off': return off(port, json);
    case 'tailscale': return cmdRemoteTailscale(port, args, json);
    case 'trust': return cmdRemoteTrust(port, args, json);
    case 'untrust': return cmdRemoteUntrust(port, args, json);
    case 'cloudflare': return cmdRemoteCloudflare(port, args, json);
    default:
      console.error(HELP);
      process.exit(EXIT.USAGE);
  }
}

interface RemoteStatus { bindHost: string; port: number; allowHosts: string[]; sessions: number; trust?: { tailscale?: { logins: string[] }; cloudflare?: Array<{ team: string; emails: string[] }> } }

export async function remoteStatus(port: number): Promise<RemoteStatus> {
  const st = await fetchJson(port, '/api/remote');
  if (!st || !Array.isArray(st.allowHosts)) {
    console.error('this ttym server predates remote access — upgrade and restart it (ttym upgrade)');
    process.exit(EXIT.VERSION);
  }
  return st;
}

function out(json: boolean, value: unknown, text: string) {
  console.log(json ? JSON.stringify(value, null, 2) : text);
}

async function status(port: number, json: boolean) {
  const st = await remoteStatus(port);
  const loopback = isLoopbackBind(st.bindHost);
  out(json, { ...st, lanExposed: !loopback }, [
    `bind:          ${st.bindHost}${loopback ? '' : '  (LAN — plain HTTP)'}`,
    `allowed hosts: ${st.allowHosts.length ? st.allowHosts.join(', ') : '(none — remote access off)'}`,
    `browsers:      ${st.sessions} signed in`,
    `trusted:       ${[...(st.trust?.tailscale?.logins ?? []).map((l) => `tailscale ${l}`), ...(st.trust?.cloudflare ?? []).map((c) => `access ${c.team} ${c.emails.join(',')}`)].join(' · ') || '(none — every new browser needs a link)'}`,
  ].join('\n'));
}

export async function addAllowHost(port: number, host: string) {
  return fetchRequest(port, 'POST', '/api/remote/hosts', { host });
}

async function allowHost(port: number, host: string | undefined, json: boolean) {
  if (!host) { console.error('usage: ttym remote allow-host <host>'); process.exit(EXIT.USAGE); }
  const r = await addAllowHost(port, host);
  if (!r?.host) { console.error(r?.error ?? 'failed'); process.exit(EXIT.FAIL); }
  out(json, r, `${r.changed ? 'allowed' : 'already allowed'}: ${r.host}`);
}

async function disallowHost(port: number, host: string | undefined, json: boolean) {
  if (!host) { console.error('usage: ttym remote disallow-host <host>'); process.exit(EXIT.USAGE); }
  const r = await fetchRequest(port, 'DELETE', `/api/remote/hosts/${encodeURIComponent(host)}`);
  out(json, r, `${r?.changed ? 'removed' : 'not in the list'}: ${r?.host ?? host}`);
}

/**
 * Where a browser reaches an allowed host:
 *   IP or *.local (mDNS)            → http://host:<port>  — the server itself, LAN bind
 *   *.lan · *.internal · *.home.arpa → http://host          — a local reverse proxy on :80
 *   anything else                    → https://host         — tunnel or tailscale serve
 */
export function baseUrlFor(host: string, port: number): string {
  if (isIP(host) !== 0 || host.endsWith('.local')) return `http://${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
  if (/\.(lan|internal|home\.arpa)$/.test(host)) return `http://${host}`;
  return `https://${host}`;
}

export async function mintLink(port: number, host: string) {
  const r = await fetchRequest(port, 'POST', '/api/remote/links', { host });
  if (!r?.token) throw new Error(r?.error ?? 'could not mint a login link');
  return { url: `${baseUrlFor(host, port)}/auth#t=${r.token}`, expiresAt: r.expiresAt as number };
}

export async function printQr(text: string) {
  if (!process.stdout.isTTY) return;
  const qr = (await import('qrcode-terminal')).default;
  await new Promise<void>((resolve) => qr.generate(text, { small: true }, (s: string) => { console.log(s); resolve(); }));
}

async function link(port: number, hostArg: string | null, json: boolean) {
  const st = await remoteStatus(port);
  const host = hostArg ?? (st.allowHosts.length === 1 ? st.allowHosts[0] : null);
  if (!host) {
    const msg = st.allowHosts.length
      ? `several hosts are allowed — pick one: --host ${st.allowHosts.join(' | --host ')}`
      : 'no remote host set up yet — run: ttym remote tailscale   (or: ttym remote allow-host <host>)';
    if (json) out(true, { ok: false, error: msg }, '');
    else console.error(msg);
    process.exit(EXIT.USAGE);
  }
  if (!st.allowHosts.includes(host)) {
    console.error(`${host} is not allowed — run: ttym remote allow-host ${host}`);
    process.exit(EXIT.FAIL);
  }
  const l = await mintLink(port, host);
  if (json) { out(true, { ok: true, host, ...l }, ''); return; }
  console.log(`Open on the other device (one use, 10 minutes):\n\n  ${l.url}\n`);
  await printQr(l.url);
}

async function sessions(port: number, json: boolean) {
  const r = await fetchJson(port, '/api/remote/sessions');
  const list = (r?.sessions ?? []) as Array<{ id: string; host: string | null; userAgent: string | null; lastSeenAt: number; expiresAt: number }>;
  if (json) { out(true, { sessions: list }, ''); return; }
  if (!list.length) { console.log('no browsers signed in'); return; }
  for (const s of list) {
    const seen = new Date(s.lastSeenAt).toISOString().slice(0, 16).replace('T', ' ');
    console.log(`${s.id}  ${(s.host ?? '-').padEnd(32)} last seen ${seen}  ${shortUa(s.userAgent)}`);
  }
}

function shortUa(ua: string | null): string {
  if (!ua) return '';
  const m = ua.match(/(iPhone|iPad|Android|Macintosh|Windows|Linux)/);
  const b = ua.match(/(Chrome|Safari|Firefox|Edg)\//);
  return [m?.[1], b?.[1]].filter(Boolean).join(' · ');
}

async function revoke(port: number, id: string | undefined, json: boolean) {
  if (!id) { console.error('usage: ttym remote revoke <id>|--all'); process.exit(EXIT.USAGE); }
  const r = await fetchRequest(port, 'DELETE', `/api/remote/sessions/${encodeURIComponent(id)}`);
  out(json, r, `signed out ${r?.revoked ?? 0} browser(s)`);
}

async function off(port: number, json: boolean) {
  const st = await remoteStatus(port);
  for (const h of st.allowHosts) await fetchRequest(port, 'DELETE', `/api/remote/hosts/${encodeURIComponent(h)}`);
  const r = await fetchRequest(port, 'DELETE', '/api/remote/sessions/all');
  out(json, { removedHosts: st.allowHosts, revoked: r?.revoked ?? 0 },
    `removed hosts: ${st.allowHosts.join(', ') || '(none)'}\nsigned out ${r?.revoked ?? 0} browser(s)\n` +
    'The tunnel / tailscale serve itself is left running; with no allowed host it only gets 403s.\n' +
    'To stop it too: `tailscale serve reset` (clears all serve config) or remove the Cloudflare tunnel.');
}

const isLoopbackBind = (h: string) => h === '127.0.0.1' || h === '::1' || h === 'localhost';

async function doctor(port: number, urls: string[], json: boolean) {
  const steps = new Steps(json);
  const st = await remoteStatus(port);
  steps.add('server', 'ok', `ttym on 127.0.0.1:${port}`);
  if (isLoopbackBind(st.bindHost)) steps.add('bind', 'ok', `listening on ${st.bindHost} only`);
  else steps.add('bind', 'warn', `listening on ${st.bindHost}: LAN devices reach it over plain HTTP (login still required)`);

  // The guards, tested from here: a foreign Host (DNS rebinding) and a foreign Origin must both bounce.
  const rebinding = await rawStatus(port, '/api/sessions', { host: `rebind.invalid:${port}` });
  const crossSite = await rawStatus(port, '/api/config', { host: `127.0.0.1:${port}`, origin: 'https://example.invalid', 'content-type': 'application/json' }, 'PATCH');
  if (rebinding === 403 && crossSite === 403) steps.add('guards', 'ok', 'foreign Host and cross-site Origin are refused');
  else steps.add('guards', 'fail', `foreign Host → ${rebinding}, cross-site write → ${crossSite} (want 403, 403)`, { fix: 'upgrade the ttym server and restart it' });

  const targets = urls.length ? urls.map((u) => u.replace(/\/+$/, '')) : st.allowHosts.map((h) => baseUrlFor(h, port));
  if (!targets.length) {
    steps.add('remote', 'ok', 'no allowed hosts — remote access is off', { fix: 'ttym remote tailscale   (recommended) · or ttym remote cloudflare --host <h> --email <e>' });
  }
  for (const base of targets) {
    const host = new URL(base).hostname;
    if (!st.allowHosts.includes(host)) steps.add('allow-host', 'fail', `${host} is not in the allowed hosts`, { fix: `ttym remote allow-host ${host}` });
    for (const c of await checkTarget(base, { port })) steps.add('login-gate', c.status, c.detail, c.fix ? { fix: c.fix } : {});
  }
  steps.finish({ bindHost: st.bindHost, allowHosts: st.allowHosts, sessions: st.sessions },
    steps.blocked ? undefined : targets.length ? 'Remote access looks right. New device: ttym remote link' : undefined);
}
