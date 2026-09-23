import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { EXIT, fetchJson, fetchRequest, readOption } from './common.js';

/**
 * ttym remote trust — let a proxy's verified identity stand in for the login link.
 *
 *   tailscale   the tailnet login(s) whose devices open ttym directly
 *               (checked per device with `tailscale whois`)
 *   cloudflare  an Access app (team + aud) and the emails its JWT may carry
 *               (signature checked against the team's keys)
 *
 * Both team and aud of an Access app can be read without an API token: an
 * unauthenticated request is redirected to
 * https://<team>.cloudflareaccess.com/cdn-cgi/access/login/<host>?kid=<aud>…
 */

/** This machine's tailnet login, from `tailscale status --json` (Self.UserID → User[id].LoginName). */
export function tailscaleOwnerLogin(bin = 'tailscale'): string | null {
  try {
    const st = JSON.parse(execFileSync(bin, ['status', '--json'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }));
    return st.User?.[String(st.Self?.UserID)]?.LoginName ?? null;
  } catch { return null; }
}

/** team + aud from the Access login redirect of an unauthenticated request. */
export async function discoverAccess(host: string): Promise<{ team: string; aud: string } | { error: string }> {
  let res: Response;
  try { res = await fetch(`https://${host}/`, { redirect: 'manual', signal: AbortSignal.timeout(10000) }); }
  catch (err) { return { error: `https://${host} unreachable (${(err as { cause?: { code?: string } }).cause?.code ?? (err as Error).message})` }; }
  const loc = res.headers.get('location') ?? '';
  const m = loc.match(/^https:\/\/([a-z0-9-]+)\.cloudflareaccess\.com\/.*[?&]kid=([a-f0-9]+)/i);
  if (!m) return { error: `https://${host} is not behind Cloudflare Access (answered ${res.status}${loc ? ` → ${loc.slice(0, 60)}` : ''})` };
  return { team: m[1]!.toLowerCase(), aud: m[2]!.toLowerCase() };
}

export async function trustTailscale(port: number, login: string) {
  return fetchRequest(port, 'POST', '/api/remote/trust', { kind: 'tailscale', login });
}
export async function trustCloudflare(port: number, team: string, aud: string, emails: string[]) {
  return fetchRequest(port, 'POST', '/api/remote/trust', { kind: 'cloudflare', team, aud, emails });
}

export async function cmdRemoteTrust(port: number, args: string[], json: boolean) {
  const kind = args[0];
  const print = (v: unknown, text: string) => console.log(json ? JSON.stringify(v, null, 2) : text);
  if (!kind || kind.startsWith('--')) {
    const st = await fetchJson(port, '/api/remote');
    const t = st?.trust ?? {};
    const lines = [
      `tailscale:  ${t.tailscale?.logins?.join(', ') || '(none)'}`,
      ...((t.cloudflare ?? []).length ? t.cloudflare.map((c: { team: string; aud: string; emails: string[] }) => `cloudflare: ${c.team} aud ${c.aud.slice(0, 12)}… → ${c.emails.join(', ')}`) : ['cloudflare: (none)']),
    ];
    print({ trust: t }, lines.join('\n'));
    return;
  }
  if (kind === 'tailscale') {
    const login = readOption(args, '--login') ?? tailscaleOwnerLogin();
    if (!login) { console.error('could not read this machine\'s tailnet login — pass --login you@example.com'); process.exit(EXIT.FAIL); }
    const r = await trustTailscale(port, login!);
    print(r, `${r?.changed ? 'trusting' : 'already trusting'} tailnet login ${login} — its devices open ttym without a link`);
    return;
  }
  if (kind === 'cloudflare') {
    const host = readOption(args, '--host');
    const emails = (readOption(args, '--email') ?? '').split(',').map((e) => e.trim()).filter(Boolean);
    if (!emails.length || (!host && !(readOption(args, '--team') && readOption(args, '--aud')))) {
      console.error('usage: ttym remote trust cloudflare --host <host> --email <you@example.com>[,…]   (or --team <t> --aud <aud>)');
      process.exit(EXIT.USAGE);
    }
    let team = readOption(args, '--team'), aud = readOption(args, '--aud');
    if (!team || !aud) {
      const d = await discoverAccess(host!);
      if ('error' in d) { console.error(d.error); process.exit(EXIT.FAIL); }
      ({ team, aud } = d as { team: string; aud: string });
    }
    const r = await trustCloudflare(port, team!, aud!, emails);
    if (!r?.trust) { console.error(r?.error ?? 'failed'); process.exit(EXIT.FAIL); }
    print(r, `${r.changed ? 'trusting' : 'already trusting'} Access team ${team} (aud ${aud!.slice(0, 12)}…) for ${emails.join(', ')} — one Access login is enough`);
    return;
  }
  console.error('usage: ttym remote trust [tailscale [--login <l>] | cloudflare --host <h> --email <e>]');
  process.exit(EXIT.USAGE);
}

export async function cmdRemoteUntrust(port: number, args: string[], json: boolean) {
  const kind = args[0];
  if (kind !== 'tailscale' && kind !== 'cloudflare' && kind !== 'all') { console.error('usage: ttym remote untrust tailscale|cloudflare|all'); process.exit(EXIT.USAGE); }
  const r = await fetchRequest(port, 'DELETE', `/api/remote/trust/${kind}`);
  console.log(json ? JSON.stringify(r, null, 2) : `no longer trusting ${kind} identities — those browsers keep their cookies until revoked (ttym remote revoke --all)`);
}
