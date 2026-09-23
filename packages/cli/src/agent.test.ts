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

  it('절전이 돌려준 argv 에 config 가 이미 있으면 또 붙이지 않는다', () => {
    const dsp = '--dangerously-skip-permissions';
    expect(buildResumeArgs({ baseArgs: base, config: dsp, extra: [dsp] })).toEqual([...base, dsp]);
  });

  it('이미 쌓인 중복도 한 번으로 줄어든다', () => {
    const dsp = '--dangerously-skip-permissions';
    expect(buildResumeArgs({ baseArgs: base, config: dsp, extra: [dsp, dsp, dsp, '--fork-session', dsp] }))
      .toEqual([...base, '--fork-session', dsp]);
  });

  it('sleep/wake 를 몇 번 돌아도 길이가 늘지 않는다', () => {
    let args = buildResumeArgs({ baseArgs: base, config: '--dangerously-skip-permissions' });
    for (let i = 0; i < 5; i++) {
      args = buildResumeArgs({ baseArgs: base, config: '--dangerously-skip-permissions', extra: args.slice(3) });
    }
    expect(args).toEqual([...base, '--dangerously-skip-permissions']);
  });

  it('값이 붙은 플래그는 값까지 같아야 같은 것 — 다른 값은 둘 다 남는다', () => {
    expect(buildResumeArgs({ baseArgs: base, config: '--model opus', extra: ['--model', 'haiku'] }))
      .toEqual([...base, '--model', 'opus', '--model', 'haiku']);
  });

  it('겹치면 마지막 자리에 남긴다 — 뒤엣것이 이기는 순서가 안 바뀌게', () => {
    expect(buildResumeArgs({ baseArgs: base, config: '--model a', env: '--model b', extra: ['--model', 'a'] }))
      .toEqual([...base, '--model', 'b', '--model', 'a']);
  });

  it('codex 의 -c key=val 도 같은 규칙', () => {
    const cfg = ['-c', 'check_for_update_on_startup=false'];
    expect(buildResumeArgs({ baseArgs: ['codex', 'resume', 'x'], extra: [...cfg, ...cfg] }))
      .toEqual(['codex', 'resume', 'x', ...cfg]);
  });
});
