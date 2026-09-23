import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import process from 'node:process';
import { Steps, checkTarget } from './remote-steps.js';
import { addAllowHost, mintLink, printQr, remoteStatus } from './remote.js';

/**
 * ttym remote tailscale — the recommended path.
 *
 * `tailscale serve` proxies https://<machine>.<tailnet>.ts.net → 127.0.0.1:<port>.
 * Only devices in the tailnet can reach it, Tailscale issues the certificate,
 * and ttym keeps listening on loopback. Measured against tailscale 1.102:
 *   serve --bg --yes --https=443 http://127.0.0.1:<port>
 *   serve status --json → { Web: { "<name>:443": { Handlers: { "/": { Proxy } } } } }
 */
const CANDIDATES = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];

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

  let st: { BackendState?: string; Self?: { DNSName?: string }; CertDomains?: string[] | null; MagicDNSSuffix?: string };
  try { st = JSON.parse(ts(bin!, ['status', '--json'])); } catch { st = {}; }
  if (st.BackendState !== 'Running') {
    steps.add('login', 'human', `Tailscale is ${st.BackendState ?? 'not running'} — sign this machine in`, { fix: 'tailscale up   (prints a login URL; open it in a browser)' });
    done();
  }
  const name = (st.Self?.DNSName ?? '').replace(/\.$/, '');
  if (!name) {
    steps.add('name', 'human', 'MagicDNS is off, so this machine has no tailnet name', { url: 'https://login.tailscale.com/admin/dns' });
    done();
  }
  steps.add('login', 'ok', `signed in as ${name}`);

  if (!(st.CertDomains ?? []).includes(name)) {
    steps.add('https', 'human', 'HTTPS certificates are off for this tailnet — turn on "HTTPS Certificates" under DNS (once per tailnet)', { url: 'https://login.tailscale.com/admin/dns' });
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

  if (dryRun) done({ host: name });

  // The first request on a fresh name waits for the certificate; give it time.
  for (const c of await checkTarget(`https://${name}`, { retryMs: 45_000 })) steps.add('doctor', c.status, c.detail, c.fix ? { fix: c.fix } : {});
  if (steps.blocked) done({ host: name });

  const l = await mintLink(port, name);
  steps.add('link', 'ok', `login link minted (one use, 10 min)`);
  const next = 'On the phone: install Tailscale, sign in with the same account, then open the link.';
  if (!json) {
    console.log(`\n${next}\n\n  ${l.url}\n`);
    await printQr(l.url);
  }
  done({ host: name, url: `https://${name}`, link: l.url, linkExpiresAt: l.expiresAt, next });
}
