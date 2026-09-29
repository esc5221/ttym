import { execFileSync } from 'node:child_process';
import { existsSync, openSync, readSync, closeSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import process from 'node:process';

/**
 * 에이전트 대화 하나를 id로 찾는다 — 어느 에이전트의 것인지, 어디서 시작됐는지(cwd), 지금 어딘가에서
 * 돌고 있는지. `ttym agent adopt`와 `resume`이 같은 대화를 두 번 띄우지 않게 하려고 쓴다.
 *
 *   Claude  ~/.claude/projects/<cwd 인코딩>/<id>.jsonl — 줄마다 cwd가 있다.
 *           실행 중: ~/.claude/sessions/<pid>.json 에 sessionId·pid가 있다 (Claude가 직접 쓴다).
 *   Codex   $CODEX_HOME/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl — 첫 줄 session_meta에 cwd.
 *           실행 중: 상태 파일이 없다. 도는 Codex는 자기 rollout을 열어 두므로 lsof로 찾는다.
 */

export type AgentKind = 'claude' | 'codex';

export interface Conversation {
  kind: AgentKind;
  id: string;
  path: string;
  cwd: string | null;
}

export interface RunningCopy {
  pid: number;
  /** 사람이 알아볼 단서 — Claude는 상태(busy/idle/waiting), Codex는 명령줄. */
  detail: string;
}

const HOME = process.env.HOME || '/tmp';
const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || resolve(HOME, '.claude');
const codexHome = () => process.env.CODEX_HOME || resolve(HOME, '.codex');

function firstLines(path: string, bytes = 256 * 1024): string[] {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(Math.min(bytes, statSync(path).size));
    readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('utf8').split('\n');
  } finally { closeSync(fd); }
}

function findClaude(id: string): Conversation | null {
  const root = join(claudeHome(), 'projects');
  if (!existsSync(root)) return null;
  for (const dir of readdirSync(root)) {
    const path = join(root, dir, `${id}.jsonl`);
    if (!existsSync(path)) continue;
    let cwd: string | null = null;
    for (const line of firstLines(path)) {
      try { const e = JSON.parse(line); if (typeof e.cwd === 'string') { cwd = e.cwd; break; } } catch {}
    }
    return { kind: 'claude', id, path, cwd };
  }
  return null;
}

function findCodex(id: string): Conversation | null {
  const root = join(codexHome(), 'sessions');
  if (!existsSync(root)) return null;
  // YYYY/MM/DD — 최근 날짜부터. 대화는 대개 최근 것이다.
  const years = readdirSync(root).filter((d) => /^\d{4}$/.test(d)).sort().reverse();
  for (const y of years) for (const m of readdirSync(join(root, y)).sort().reverse()) for (const d of readdirSync(join(root, y, m)).sort().reverse()) {
    const dir = join(root, y, m, d);
    const file = readdirSync(dir).find((f) => f.startsWith('rollout-') && f.endsWith(`-${id}.jsonl`));
    if (!file) continue;
    const path = join(dir, file);
    let cwd: string | null = null;
    try { const meta = JSON.parse(firstLines(path, 64 * 1024)[0] ?? ''); if (typeof meta?.payload?.cwd === 'string') cwd = meta.payload.cwd; } catch {}
    return { kind: 'codex', id, path, cwd };
  }
  return null;
}

/** id로 대화를 찾는다. 종류를 알면 그쪽만. */
export function findConversation(id: string, kind?: AgentKind): Conversation | null {
  if (!/^[A-Za-z0-9-]{8,}$/.test(id)) return null;
  if (kind === 'claude') return findClaude(id);
  if (kind === 'codex') return findCodex(id);
  return findClaude(id) ?? findCodex(id);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** 이 대화가 이미 어느 프로세스에서 돌고 있나. 같은 대화를 두 곳에서 이어 쓰면 기록이 갈라진다. */
export function runningCopies(conv: Conversation): RunningCopy[] {
  if (conv.kind === 'claude') {
    const dir = join(claudeHome(), 'sessions');
    if (!existsSync(dir)) return [];
    const out: RunningCopy[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const s = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        // 죽은 pid의 파일이 남아 있을 수 있다 — 살아 있는 것만.
        if (s.sessionId === conv.id && typeof s.pid === 'number' && alive(s.pid)) out.push({ pid: s.pid, detail: `claude, ${s.status ?? 'running'}${s.cwd ? ` in ${s.cwd}` : ''}` });
      } catch {}
    }
    return out;
  }
  try {
    const pids = execFileSync('lsof', ['-t', conv.path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').map((l) => parseInt(l, 10)).filter((n) => Number.isFinite(n));
    return [...new Set(pids)].map((pid) => {
      let cmd = '';
      try { cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim(); } catch {}
      return { pid, detail: cmd.slice(0, 80) || 'codex' };
    });
  } catch { return []; } // lsof는 여는 프로세스가 없으면 1로 끝난다
}
