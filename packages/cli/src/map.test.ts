import { describe, expect, it } from 'vitest';
import { extractJson, resolveStream } from './map.js';

describe('extractJson — 모델 출력 방어', () => {
  it('생 JSON을 그대로 파싱한다', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it('펜스와 서두가 붙어도 첫 균형 JSON을 건진다', () => {
    const noisy = '요약 결과입니다.\n```json\n{"sessions":{"9":{"title":"x"}}}\n```\n끝.';
    expect(extractJson(noisy)).toEqual({ sessions: { 9: { title: 'x' } } });
  });
  it('문자열 안의 중괄호에 속지 않는다', () => {
    expect(extractJson('{"note":"뭐 {이런} \\"것\\""}')).toEqual({ note: '뭐 {이런} "것"' });
  });
  it('JSON이 없으면 null', () => {
    expect(extractJson('없음')).toBeNull();
    expect(extractJson('{"broken":')).toBeNull();
  });
});

describe('resolveStream — 요약기가 사용자의 이름을 덮지 않는다', () => {
  it('이미 이름이 있으면 요약기의 제안을 무시한다', () => {
    expect(resolveStream('gpai', 'GPAI 프로젝트', false)).toBe('gpai');
  });
  it('--force면 요약기가 다시 묶는다', () => {
    expect(resolveStream('gpai', 'gemma4', true)).toBe('gemma4');
  });
  it('이름이 없으면 요약기가 붙인다', () => {
    expect(resolveStream(undefined, ' ttym ', false)).toBe('ttym');
    expect(resolveStream('', 'ttym', false)).toBe('ttym');
  });
  it('요약기가 빈 값을 주면 미분류로 떨어진다 — 다음 판에서 또 안 걸리게', () => {
    expect(resolveStream(undefined, '', false)).toBe('미분류');
    expect(resolveStream(undefined, null, false)).toBe('미분류');
  });
  it('--force인데 요약기가 빈 값이면 기존 이름을 지킨다 — 강제가 삭제는 아니다', () => {
    expect(resolveStream('gpai', '', true)).toBe('gpai');
  });
  it('30자를 넘기지 않는다', () => {
    expect(resolveStream(undefined, 'x'.repeat(50), false)).toHaveLength(30);
  });
});
