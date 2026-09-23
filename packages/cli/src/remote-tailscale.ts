import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import process from 'node:process';
import { Steps, checkTarget, rawStatus } from './remote-steps.js';
import { addAllowHost, mintLink, printQr, remoteStatus } from './remote.js';
import { tailscaleOwnerLogin, trustTailscale } from './remote-trust.js';

/**
 * ttym remote tailscale — the recommended path.
 *
 * `tailscale serve` proxies https://<machine>.<tailnet>.ts.net → 127.0.0.1:<port>.
 * Only devices in the tailnet can reach it, Tailscale issues the certificate,
 * and ttym keeps listening on loopback. Measured against tailscale 1.102:
 *   serve --bg --yes --https=443 http://127.0.0.1:<port>
 *   serve status --json → { Web: { "<name>:443": { Handlers: { "/": { Proxy } } } } }
 *
 * --ip: no name, no certificate — http://<100.x IP>:<port>. HTTP serve
 * handlers are keyed by the MagicDNS name, so a request by IP gets
 * Tailscale's own 404 (measured); a raw TCP forward carries any Host:
 *   serve --bg --yes --tcp=<port> tcp://127.0.0.1:<port>
 *   serve status --json → { TCP: { "<port>": { TCPForward: "127.0.0.1:<port>" } } }
 * WireGuard still encrypts the path, but the browser sees plain HTTP (not a
 * secure context: no Secure cookie, no clipboard API).
 */
const CANDIDATES = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
const IP_ALT = { command: 'ttym remote tailscale --ip', tradeoff: 'works now at http://<100.x>:<port>; plain HTTP in the browser (no clipboard API), still WireGuard-encrypted' };

function findTailscale(): string | null {
  for (const bin of CANDIDATES) {
    if (bin.startsWith('/') && !existsSync(bin)) continue;
    try { execFileSync(bin, ['version'], { stdio: 'ignore', timeout: 5000 }); return bin; } catch {}
  }
  return null;
}

function ts(bin: string, args: string[]): string {
  return execFileSync(bin, args, { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
}

interface ServeStatus { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> }

export async function cmdRemoteTailscale(port: number, args: string[], json: boolean) {
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  const ipMode = args.includes('--ip');
  const steps = new Steps(json);
  const target = `http://127.0.0.1:${port}`;
  const done = (extra: Record<string, unknown> = {}, note?: string) => steps.finish({ path: 'tailscale', dryRun, ...extra }, note);

  const bin = findTailscale();
  if (!bin) {
    steps.add('cli', 'human', 'Tailscale is not installed on this machine', {
      url: 'https://tailscale.com/download',
      fix: process.platform === 'darwin' ? 'brew install --cask tailscale   (then open the app once)' : 'curl -fsSL https://tailscale.com/install.sh | sh',
    });
    done();
  }
  steps.add('cli', 'ok', `${bin} (${ts(bin!, ['version']).split('\n')[0]})`);

  let st: { BackendState?: string; Self?: { DNSName?: string; TailscaleIPs?: string[] }; CertDomains?: string[] | null; MagicDNSSuffix?: string };
  try { st = JSON.parse(ts(bin!, ['status', '--json'])); } catch { st = {}; }
  if (st.BackendState !== 'Running') {
    steps.add('login', 'human', `Tailscale is ${st.BackendState ?? 'not running'} — sign this machine in`, { fix: 'tailscale up   (prints a login URL; open it in a browser)' });
    done();
  }
  if (ipMode) return ipPath(bin!, st.Self?.TailscaleIPs ?? [], port, steps, dryRun, force, json, done);
  const name = (st.Self?.DNSName ?? '').replace(/\.$/, '');
  if (!name) {
    steps.add('name', 'human', 'MagicDNS is off, so this machine has no tailnet name — turn it on for the tailnet (this machine can keep its own DNS: tailscale set --accept-dns=false)', {
      url: 'https://login.tailscale.com/admin/dns', alternatives: [IP_ALT],
    });
    done();
  }
  steps.add('login', 'ok', `signed in as ${name}`);

  if (!(st.CertDomains ?? []).includes(name)) {
    steps.add('https', 'human', 'HTTPS certificates are off for this tailnet — turn on "HTTPS Certificates" under DNS (once per tailnet)', {
      url: 'https://login.tailscale.com/admin/dns', alternatives: [IP_ALT],
    });
    done({ host: name });
  }
  steps.add('https', 'ok', 'HTTPS certificates enabled');

  const readServe = (): ServeStatus => { try { return JSON.parse(ts(bin!, ['serve', 'status', '--json'])); } catch { return {}; } };
  const rootProxy = (s: ServeStatus) => s.Web?.[`${name}:443`]?.Handlers?.['/']?.Proxy ?? null;
  const current = rootProxy(readServe());
  if (current === target) steps.add('serve', 'ok', `https://${name} → ${target}`);
  else if (current && !force) {
    steps.add('serve', 'fail', `https://${name}/ already proxies to ${current}`, { fix: `ttym remote tailscale --force   (replaces it with ${target})` });
    done({ host: name });
  } else if (dryRun) steps.add('serve', 'planned', `tailscale serve --bg --https=443 ${target}`);
  else {
    try { ts(bin!, ['serve', '--bg', '--yes', '--https=443', target]); } catch (err) {
      const e = err as { stderr?: string; message: string };
      steps.add('serve', 'fail', `tailscale serve failed: ${(e.stderr || e.message).trim().split('\n')[0]}`, { fix: `tailscale serve --bg --https=443 ${target}` });
      done({ host: name });
    }
    if (rootProxy(readServe()) !== target) { steps.add('serve', 'fail', 'tailscale serve ran but the handler is not there'); done({ host: name }); }
    steps.add('serve', 'changed', `https://${name} → ${target}`);
  }

  const allowed = (await remoteStatus(port)).allowHosts.includes(name);
  if (allowed) steps.add('allow-host', 'ok', name);
  else if (dryRun) steps.add('allow-host', 'planned', name);
  else { await addAllowHost(port, name); steps.add('allow-host', 'changed', name); }

  // The machine owner's devices open it directly: serve's identity header, confirmed by whois.
  const owner = tailscaleOwnerLogin(bin!);
  const trusted = (await remoteStatus(port)).trust?.tailscale?.logins ?? [];
  if (!owner) steps.add('trust', 'warn', 'could not read this machine\'s tailnet login — devices will need a link (ttym remote trust tailscale --login …)');
  else if (trusted.includes(owner.toLowerCase())) steps.add('trust', 'ok', `devices signed in as ${owner} open ttym without a link`);
  else if (dryRun) steps.add('trust', 'planned', `trust tailnet login ${owner}`);
  else { await trustTailscale(port, owner); steps.add('trust', 'changed', `devices signed in as ${owner} open ttym without a link`); }

  if (dryRun) done({ host: name });

  // The first request on a fresh name waits for the certificate; give it time.
  for (const c of await checkTarget(`https://${name}`, { retryMs: 45_000, port })) steps.add('doctor', c.status, c.detail, c.fix ? { fix: c.fix } : {});
  if (steps.blocked) done({ host: name });

  const l = await mintLink(port, name);
  steps.add('link', 'ok', `login link minted (one use, 10 min)`);
  const next = owner
    ? `On the phone: install Tailscale, sign in as ${owner}, then open https://${name} — no link needed. (For a device signed in as someone else, use the one-time link.)`
    : 'On the phone: install Tailscale, sign in with the same account, then open the link.';
  if (!json) {
    console.log(`\n${next}\n\n  https://${name}\n\n  one-time link: ${l.url}\n`);
    await printQr(owner ? `https://${name}` : l.url);
  }
  done({ host: name, url: `https://${name}`, link: l.url, linkExpiresAt: l.expiresAt, next });
}

interface TcpServe { TCP?: Record<string, { TCPForward?: string }> }

async function ipPath(bin: string, ips: string[], port: number, steps: Steps, dryRun: boolean, force: boolean, json: boolean,
  done: (extra?: Record<string, unknown>, note?: string) => never) {
  const ip = ips.find((a) => a.includes('.'));
  if (!ip) { steps.add('ip', 'fail', 'this machine has no Tailscale IPv4 address'); done(); }
  steps.add('ip', 'ok', ip!);
  const target = `127.0.0.1:${port}`;
  const readTcp = (): string | null => {
    try { return (JSON.parse(ts(bin, ['serve', 'status', '--json'])) as TcpServe).TCP?.[String(port)]?.TCPForward ?? null; } catch { return null; }
  };
  const current = readTcp();
  if (current === target) steps.add('serve', 'ok', `tailnet ${ip}:${port} → ${target} (tcp)`);
  else if (current && !force) {
    steps.add('serve', 'fail', `tailnet port ${port} already forwards to ${current}`, { fix: 'ttym remote tailscale --ip --force' });
    done({ host: ip });
  } else if (dryRun) steps.add('serve', 'planned', `tailscale serve --bg --tcp=${port} tcp://${target}`);
  else {
    try { ts(bin, ['serve', '--bg', '--yes', `--tcp=${port}`, `tcp://${target}`]); } catch (err) {
      const e = err as { stderr?: string; message: string };
      steps.add('serve', 'fail', `tailscale serve failed: ${(e.stderr || e.message).trim().split('\n')[0]}`, { fix: `tailscale serve --bg --tcp=${port} tcp://${target}` });
      done({ host: ip });
    }
    if (readTcp() !== target) { steps.add('serve', 'fail', 'tailscale serve ran but the forward is not there'); done({ host: ip }); }
    steps.add('serve', 'changed', `tailnet ${ip}:${port} → ${target} (tcp)`);
  }

  const allowed = (await remoteStatus(port)).allowHosts.includes(ip!);
  if (allowed) steps.add('allow-host', 'ok', ip!);
  else if (dryRun) steps.add('allow-host', 'planned', ip!);
  else { await addAllowHost(port, ip!); steps.add('allow-host', 'changed', ip!); }
  steps.add('http', 'warn', 'plain HTTP inside the tailnet: WireGuard encrypts it, but the browser treats the page as insecure (no clipboard API)');
  if (dryRun) done({ host: ip });

  // A request from this machine to its own tailnet IP does not go through serve, so the gate is
  // checked with the Host a tailnet device sends (the TCP forward adds no headers).
  const probe = await rawStatus(port, '/api/sessions', { host: `${ip}:${port}` });
  steps.add('doctor', probe === 401 ? 'ok' : 'fail', `a tailnet device without a login gets ${probe || 'no answer'} (want 401)`);
  if (steps.blocked) done({ host: ip });

  const l = await mintLink(port, ip!);
  steps.add('link', 'ok', 'login link minted (one use, 10 min)');
  const next = 'On the phone: install Tailscale, sign in with the same account, then open the link.';
  if (!json) { console.log(`\n${next}\n\n  ${l.url}\n`); await printQr(l.url); }
  done({ host: ip, url: `http://${ip}:${port}`, link: l.url, linkExpiresAt: l.expiresAt, next });
}
