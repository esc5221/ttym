import process from 'node:process';
import { request } from 'node:http';
import { WebSocket } from 'ws';

/**
 * Step reporting for `ttym remote …` — written for an agent first, a person second.
 *
 * Every setup command is a list of idempotent steps. `--json` prints
 *   { ok, …extra, steps: [{ id, status, detail, fix?, url? }] }
 * and the exit code is 0 only when nothing is `fail` or `human`:
 *   ok       already in the wanted state
 *   changed  this run put it there
 *   planned  --dry-run: would change
 *   warn     works, but worth knowing (LAN over plain HTTP, …)
 *   fail     broken; `fix` is a command to run
 *   human    needs a person (browser login, a dashboard toggle); `url` says where
 * An agent re-runs the same command after each fix or human step; finished
 * steps come back `ok`.
 */
export type StepStatus = 'ok' | 'changed' | 'planned' | 'warn' | 'fail' | 'human';
/** Another way past a blocked step, and what it costs — for an agent to offer the user a choice. */
export interface Alternative { command: string; tradeoff: string }
export interface Step { id: string; status: StepStatus; detail: string; fix?: string; url?: string; alternatives?: Alternative[] }

const MARK: Record<StepStatus, string> = { ok: '✓', changed: '✓', planned: '·', warn: '!', fail: '✗', human: '→' };

export class Steps {
  readonly steps: Step[] = [];
  constructor(readonly json: boolean) {}

  add(id: string, status: StepStatus, detail: string, extra: { fix?: string; url?: string; alternatives?: Alternative[] } = {}): Step {
    const step: Step = { id, status, detail, ...extra };
    this.steps.push(step);
    if (!this.json) {
      const tag = status === 'changed' ? ' (changed)' : status === 'planned' ? ' (planned)' : '';
      console.log(`${MARK[status]} ${id.padEnd(10)} ${detail}${tag}`);
      if (step.fix) console.log(`  ${''.padEnd(10)} ${status === 'ok' ? 'next' : 'fix: '} ${step.fix}`);
      if (step.url) console.log(`  ${''.padEnd(10)} open: ${step.url}`);
      for (const a of step.alternatives ?? []) console.log(`  ${''.padEnd(10)} or:   ${a.command}  — ${a.tradeoff}`);
    }
    return step;
  }

  get blocked(): boolean { return this.steps.some((s) => s.status === 'fail' || s.status === 'human'); }

  finish(extra: Record<string, unknown> = {}, note?: string): never {
    const ok = !this.blocked;
    if (this.json) console.log(JSON.stringify({ ok, ...extra, steps: this.steps }, null, 2));
    else if (note) console.log(`\n${note}`);
    process.exit(ok ? 0 : 1);
  }
}

/** Raw request with any Host / Origin (fetch forbids setting Host). */
export function rawStatus(port: number, path: string, headers: Record<string, string>, method = 'GET'): Promise<number> {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers, timeout: 3000 }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.end();
  });
}

export interface TargetCheck { status: StepStatus; detail: string; fix?: string; unreachable?: boolean }

/**
 * What a stranger gets at `base` with no cookie. Passing means something asks
 * for a login first: Cloudflare Access (302 to *.cloudflareaccess.com) or ttym
 * itself (401). A 200 means the terminal is open to whoever has the URL.
 */
export async function checkTarget(base: string, opts: { retryMs?: number; port?: number } = {}): Promise<TargetCheck[]> {
  const deadline = Date.now() + (opts.retryMs ?? 0);
  let http: TargetCheck;
  for (;;) {
    http = await probeHttp(base);
    if (http.status !== 'fail' || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  // This machine often cannot reach its own public URL: with `tailscale set
  // --accept-dns=false` it cannot resolve *.ts.net, and a request to its own
  // tailnet address does not loop back through serve (both measured). Then
  // check the gate here instead, sending what a tailnet device would.
  if (http.unreachable && opts.port) {
    const host = new URL(base).host;
    const probe = await rawStatus(opts.port, '/api/sessions', { host, 'x-forwarded-for': '100.64.0.1', 'tailscale-user-login': 'doctor@probe' });
    const here = `${base} is not reachable from this machine (${http.detail.replace(/^.*unreachable /, '')}) — normal when this machine does not use MagicDNS`;
    if (probe === 401) return [{ status: 'warn', detail: `${here}; the gate was checked locally with that Host → 401. Confirm by opening the URL on another device.` }];
    return [http, { status: 'fail', detail: `local gate check for ${host} → ${probe || 'no answer'} (want 401)` }];
  }
  const ws = await probeWs(base);
  return [http, ws];
}

async function probeHttp(base: string): Promise<TargetCheck> {
  let res: Response;
  try {
    res = await fetch(`${base}/api/sessions`, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    return { status: 'fail', unreachable: true, detail: `${base} unreachable (${cause?.code ?? cause?.message ?? (err as Error).message})` };
  }
  const loc = res.headers.get('location') ?? '';
  if ((res.status === 302 || res.status === 303) && /cloudflareaccess\.com/.test(loc)) {
    return { status: 'ok', detail: `${base} → Cloudflare Access login first` };
  }
  if (res.status === 401) return { status: 'ok', detail: `${base} → ttym login required` };
  if (res.status === 403) {
    const body = await res.text().catch(() => '');
    if (/host not allowed/.test(body)) {
      return { status: 'fail', detail: `${base} reaches ttym but the host is not allowed`, fix: `ttym remote allow-host ${new URL(base).hostname}` };
    }
    return { status: 'ok', detail: `${base} → refused without login (403)` };
  }
  if (res.status === 200) return { status: 'fail', detail: `${base} serves the API WITHOUT a login — anyone with the URL has a shell`, fix: 'upgrade the ttym server (this build gates remote requests) and restart it' };
  return { status: 'fail', detail: `${base} answered ${res.status}${loc ? ` → ${loc.slice(0, 80)}` : ''}` };
}

function probeWs(base: string): Promise<TargetCheck> {
  const url = base.replace(/^http/, 'ws') + '/ws';
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { handshakeTimeout: 8000 });
    ws.once('open', () => { ws.terminate(); resolve({ status: 'fail', detail: `${url} accepts a WebSocket without a login` }); });
    ws.once('unexpected-response', (_req, res) => { ws.terminate(); resolve({ status: 'ok', detail: `${url} refused without login (${res.statusCode})` }); });
    ws.once('error', (err) => resolve({ status: 'fail', detail: `${url} unreachable (${(err as Error).message})` }));
  });
}
