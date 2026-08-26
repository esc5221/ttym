import { describe, expect, it } from 'vitest';
import { buildResumeArgs } from './agent.js';

const base = ['claude', '--resume', 'abc123'];

describe('buildResumeArgs — 어디서 온 플래그가 어느 순서로 붙나', () => {
  it('아무 것도 없으면 기본 명령 그대로', () => {
    expect(buildResumeArgs({ baseArgs: base })).toEqual(base);
  });

  it('설정 창에서 정한 값만 있을 때', () => {
    expect(buildResumeArgs({ baseArgs: base, config: '--dangerously-skip-permissions' }))
      .toEqual([...base, '--dangerously-skip-permissions']);
  });

  it('env 는 config 뒤에 온다 — 이 셸에서만 다르게 하려는 것이므로', () => {
    expect(buildResumeArgs({ baseArgs: base, config: '--model opus', env: '--model haiku' }))
      .toEqual([...base, '--model', 'opus', '--model', 'haiku']);
  });

  it('명령줄에 직접 적은 것이 맨 뒤', () => {
    expect(buildResumeArgs({ baseArgs: base, config: '--a', env: '--b', extra: ['--c'] }))
      .toEqual([...base, '--a', '--b', '--c']);
  });

  it('공백은 여러 개여도 하나로 보고, 빈 값은 아무것도 안 붙인다', () => {
    expect(buildResumeArgs({ baseArgs: base, config: '  --x   --y  ', env: '   ' }))
      .toEqual([...base, '--x', '--y']);
  });

  it('없는 값(undefined·null)에 안 넘어진다', () => {
    expect(buildResumeArgs({ baseArgs: base, config: undefined, env: null as unknown as string }))
      .toEqual(base);
  });
});
