import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AGENT_RE, findAgentProcess, isInteractiveAgent, type ProcInfo } from './agent-sleep.js';

// 실제 macpro의 ps 한 장(2026-11-08, 프로세스 3472개, 경로·인자는 지움). 색인을 한 번만 만드는
// findAgentProcess가 예전 구현(부를 때마다 색인을 새로 만듦)과 모든 pid에서 같은 답을 내는지 본다.
const rows = JSON.parse(readFileSync(resolve(__dirname, '__fixtures__/ps-macpro-261108.json'), 'utf8')) as [number, number, number, string][];
const procs: ProcInfo[] = rows.map(([pid, ppid, rss, command]) => ({ pid, ppid, rss, command }));

function oldFind(list: ProcInfo[], shellPid: number): (ProcInfo & { kind: 'claude' | 'codex' }) | null {
  const root = list.find((p) => p.pid === shellPid);
  if (root) {
    const m = AGENT_RE.exec(root.command.trim().split(/\s+/)[0] ?? '');
    if (m && isInteractiveAgent(root.command, m[2] as 'claude' | 'codex')) return { ...root, kind: m[2] as 'claude' | 'codex' };
  }
  const byParent = new Map<number, ProcInfo[]>();
  for (const p of list) { const l = byParent.get(p.ppid) ?? []; l.push(p); byParent.set(p.ppid, l); }
  const queue: Array<{ pid: number; depth: number }> = [{ pid: shellPid, depth: 0 }];
  while (queue.length > 0) {
    const { pid, depth } = queue.shift()!;
    for (const child of byParent.get(pid) ?? []) {
      const m = AGENT_RE.exec(child.command.trim().split(/\s+/)[0] ?? '');
      if (m && isInteractiveAgent(child.command, m[2] as 'claude' | 'codex')) return { ...child, kind: m[2] as 'claude' | 'codex' };
      if (depth < 2) queue.push({ pid: child.pid, depth: depth + 1 });
    }
  }
  return null;
}

describe('findAgentProcess on a real process table', () => {
  it('gives the same answer as the per-call index for every parent pid', () => {
    const parents = [...new Set(procs.map((p) => p.ppid))];
    let found = 0;
    for (const pid of parents) {
      const a = oldFind(procs, pid);
      const b = findAgentProcess(procs, pid);
      expect(b).toEqual(a);
      if (b) found++;
    }
    expect(found).toBeGreaterThan(10); // 실제로 에이전트를 찾는 경우가 들어 있다
  });

  it('a new ps result gets its own index', () => {
    const shell = 900001;
    const first: ProcInfo[] = [{ pid: shell, ppid: 1, rss: 0, command: '/bin/zsh' }];
    expect(findAgentProcess(first, shell)).toBeNull();
    const second: ProcInfo[] = [...first, { pid: 900002, ppid: shell, rss: 0, command: '/usr/local/bin/claude --resume x' }];
    expect(findAgentProcess(second, shell)?.pid).toBe(900002);
  });
});
