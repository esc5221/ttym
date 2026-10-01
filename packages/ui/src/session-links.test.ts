import { describe, expect, it } from 'vitest';
import { SESSION_REF } from './session-links.js';

const refs = (s: string) => [...s.matchAll(SESSION_REF)].map((m) => m[0]);
const parts = (s: string) => [...s.matchAll(SESSION_REF)].map((m) => [m[1], m[2]]);

describe('SESSION_REF', () => {
  it('finds session numbers written as %id', () => {
    expect(refs('pane %1297 (서버factory)와 %42, 그리고 (%7).')).toEqual(['%1297', '%42', '%7']);
  });

  it('stays at four digits', () => {
    expect(refs('%12345')).toEqual([]);
  });

  it('ignores url encoding, printf formats and percentages', () => {
    expect(refs('a%20b http://x/%31 printf "%10s" 100% %d')).toEqual([]);
  });

  it('reads a machine name in front: box%78', () => {
    expect(refs('see box%78 and %5')).toEqual(['box%78', '%5']);
    expect(parts('box%78 %5 a-b%9')).toEqual([['box', '78'], [undefined, '5'], ['a-b', '9']]);
  });

  it('does not take the tail of a longer word or a path', () => {
    expect(refs('x/box%78')).toEqual([]);
    expect(refs('%%78')).toEqual([]);
  });
});
