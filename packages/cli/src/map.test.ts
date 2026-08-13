import { describe, expect, it } from 'vitest';
import { extractJson } from './map.js';

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
