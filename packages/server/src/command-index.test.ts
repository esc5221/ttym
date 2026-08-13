import { describe, expect, it } from 'vitest';
import { CommandIndex, decode633E } from './command-index.js';

function makeIndex(times: number[] = []) {
  let seq = 100;
  let t = 0;
  const idx = new CommandIndex(() => seq, () => times[t++] ?? 1000 + t);
  return { idx, bump: (n: number) => { seq += n; } };
}

describe('CommandIndex', () => {
  it('C→D가 한 명령이 된다 — exit code와 출력 구간 좌표까지', () => {
    const { idx, bump } = makeIndex([10, 20]);
    idx.osc633('E;make test');
    idx.osc133('C');
    bump(500); // 출력 500바이트
    idx.osc133('D;2');
    const [cmd] = idx.list();
    expect(cmd).toMatchObject({
      n: 1, cmdline: 'make test', exitCode: 2,
      startedAt: 10, endedAt: 20, startSeq: 100, endSeq: 600,
    });
  });

  it('D 없이 프롬프트(A)가 돌아오면 미완(exitCode null)으로 마감한다', () => {
    const { idx } = makeIndex();
    idx.osc133('C');
    idx.osc133('A'); // Ctrl-C 등
    expect(idx.list()[0].exitCode).toBeNull();
    expect(idx.list()[0].endedAt).not.toBeNull();
  });

  it('진행 중 명령은 list 끝에 endedAt=null로 보인다', () => {
    const { idx } = makeIndex();
    idx.osc633('E;sleep 999');
    idx.osc133('C');
    const cmds = idx.list();
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toMatchObject({ cmdline: 'sleep 999', endedAt: null, exitCode: null });
  });

  it('E는 바로 다음 C에만 붙는다 — 그 다음 명령에 새지 않는다', () => {
    const { idx } = makeIndex();
    idx.osc633('E;first');
    idx.osc133('C');
    idx.osc133('D;0');
    idx.osc133('C'); // E 없이
    idx.osc133('D;0');
    const [a, b] = idx.list();
    expect(a.cmdline).toBe('first');
    expect(b.cmdline).toBeNull();
  });

  it('500개 초과는 오래된 것부터 버린다 — total은 계속 센다', () => {
    const { idx } = makeIndex();
    for (let i = 0; i < 510; i++) { idx.osc133('C'); idx.osc133('D;0'); }
    expect(idx.list(500)).toHaveLength(500);
    expect(idx.total).toBe(510);
    expect(idx.list(500)[0].n).toBe(11);
  });

  it('decode633E — 이중 이스케이프가 한 번에 풀리지 않는다', () => {
    expect(decode633E('echo a\\x3bb')).toBe('echo a;b');
    expect(decode633E('printf \\\\x3b')).toBe('printf \\x3b'); // \\ 먼저: 리터럴 \x3b 보존
    expect(decode633E('a\\x0ab')).toBe('a\nb');
  });
});
