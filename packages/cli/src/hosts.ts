import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { HOME_DIR } from './common.js';

/**
 * 다른 머신의 ttym을 이 머신에서 부른다.
 *
 *   ttym screen box%78                      그 머신의 세션 78
 *   ttym await box/api:term-78 -- "…"
 *   ttym --host box workspace info          명령 전체를 그 머신에서
 *
 * 이름은 ~/.ttym/hosts.json 에 둔다: { "box": { "ssh": "box", "url": "https://box.example.com" } }. url은 웹에서 링크를 열 때만 쓴다.
 * 명령은 ssh로 그 머신의 ttym이 실행한다. HTTP로 그 서버에 직접 붙지 않는 이유: await의 답과
 * 세션 기록(transcript)은 그 머신의 디스크에 있고, 그 서버의 원격 인증 게이트를 건드리지 않아도 된다.
 * ttym이 출력하는 목록의 %78은 box%78로 바꿔서, 받은 주소를 그대로 다음 명령에 쓸 수 있게 한다.
 * 화면·명령 출력·에이전트의 답은 내용이라 바꾸지 않는다.
 */

/** ssh: CLI가 명령을 넘길 때 쓴다. url: 그 머신의 웹 주소 — 있으면 터미널 속 box%78을 눌러 거기서 열 수 있다. */
export interface HostEntry { ssh: string; url?: string }
export type Hosts = Record<string, HostEntry>;

export function readHosts(): Hosts {
  try {
    const raw = JSON.parse(readFileSync(resolve(HOME_DIR, 'hosts.json'), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

const HOST_ID = /^([A-Za-z][\w-]*)%(\d{1,4})$/;
const HOST_ADDR = /^([A-Za-z][\w-]*)\/([^/]*:.*)$/;

/**
 * argv에서 다른 머신을 가리키는 주소를 찾아, 그 머신 이름과 그 머신 기준으로 고친 argv를 돌려준다.
 * `--` 뒤(보낼 글자)는 건드리지 않는다 — 프롬프트 속 "box%78"까지 바꾸면 보낸 말이 달라진다.
 * 이 머신의 명령이면 null.
 */
export function splitRemote(argv: string[], hosts: Hosts): { host: string; args: string[] } | { error: string } | null {
  const args = argv.slice();
  let end = args.indexOf('--') === -1 ? args.length : args.indexOf('--');
  const found = new Set<string>();
  for (let i = 0; i < end; i++) {
    if (args[i] === '--host' && i + 1 < end) {
      found.add(args[i + 1]);
      args.splice(i, 2);
      end -= 2;
      i -= 1;
      continue;
    }
    const id = args[i].match(HOST_ID);
    const addr = id ? null : args[i].match(HOST_ADDR);
    const m = id ?? addr;
    if (!m || !hosts[m[1]]) continue;
    found.add(m[1]);
    args[i] = id ? `%${m[2]}` : m[2];
  }
  if (found.size === 0) return null;
  if (found.size > 1) return { error: `one machine per command: ${[...found].join(', ')}` };
  const host = [...found][0];
  if (!hosts[host]) return { error: `unknown host ${host} — add it to ~/.ttym/hosts.json` };
  return { host, args };
}

/** 원격 셸에 넘길 한 낱말. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** 원격 출력 속 %78을 box%78로. 앞에 글자·%·/ 가 붙은 것(URL 인코딩, 이미 붙은 이름)은 그대로. */
export function qualify(text: string, host: string): string {
  return text.replace(/(?<![\w%/])%(\d{1,4})(?!\w)/g, `${host}%$1`);
}

/** "ttym await --id …", "ttym turn …" 안내는 그 머신의 요청을 가리킨다 — 여기서 그대로 치면 못 찾는다. */
export function qualifyHints(text: string, host: string): string {
  return text.replace(/\bttym (await --id|turn) /g, `ttym --host ${host} $1 `);
}

/** 출력이 세션의 내용(화면·명령 출력·에이전트의 답)인 명령. 거기 적힌 %78은 손대지 않는다. */
const CONTENT_COMMANDS = new Set(['screen', 'output', 'await', 'turn', 'commands']);

export function runRemote(host: string, entry: HostEntry, args: string[]): Promise<number> {
  // 로그인 셸로 실행한다: 비대화형 ssh의 PATH에는 node·ttym이 없는 경우가 흔하다.
  const remote = `exec "$SHELL" -lc ${shq(['ttym', ...args].map(shq).join(' '))}`;
  // 화면을 쥐는 명령(attach, 인자 없는 진입)만 터미널을 할당한다. 나머지는 출력을 받아 주소를 고친다.
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && (args.length === 0 || args[0] === 'attach');
  const child = spawn('ssh', [...(interactive ? ['-t'] : []), entry.ssh, remote], {
    stdio: interactive ? 'inherit' : ['inherit', 'pipe', 'pipe'],
  });
  if (!interactive) {
    const ids = !CONTENT_COMMANDS.has(args[0]);
    pipeQualified(child.stdout!, process.stdout, host, ids);
    pipeQualified(child.stderr!, process.stderr, host, ids);
  }
  return new Promise((done) => {
    child.on('error', (err) => { console.error(`ssh ${entry.ssh}: ${err.message}`); done(1); });
    child.on('close', (code) => done(code ?? 1));
  });
}

function pipeQualified(from: NodeJS.ReadableStream, to: NodeJS.WritableStream, host: string, ids: boolean) {
  const fix = (t: string) => qualifyHints(ids ? qualify(t, host) : t, host);
  let rest = '';
  from.setEncoding('utf8');
  from.on('data', (chunk: string) => {
    const text = rest + chunk;
    const cut = text.lastIndexOf('\n') + 1;
    rest = text.slice(cut);
    if (cut) to.write(fix(text.slice(0, cut)));
  });
  from.on('end', () => { if (rest) to.write(fix(rest)); });
}
