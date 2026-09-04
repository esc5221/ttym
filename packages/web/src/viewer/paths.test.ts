import { describe, expect, it } from 'vitest';
import { parsePathCandidate } from './paths.js';

const cwd = '/Users/me/proj';
const home = '/Users/me';
const p = (s: string) => parsePathCandidate(s, cwd, home);

describe('paths a terminal actually prints', () => {
  it('relative against the pane cwd, with the dressings stripped', () => {
    expect(p('src/viewer/renderers/MarkdownView.tsx')).toEqual({ target: `${cwd}/src/viewer/renderers/MarkdownView.tsx` });
    expect(p('"src/a.ts"')).toEqual({ target: `${cwd}/src/a.ts` });
    expect(p('`src/a.ts`')).toEqual({ target: `${cwd}/src/a.ts` });
    expect(p('(src/a.ts)')).toEqual({ target: `${cwd}/src/a.ts` });
    expect(p('src/a.ts,')).toEqual({ target: `${cwd}/src/a.ts` });
    expect(p('  ./src/a.ts  ')).toEqual({ target: `${cwd}/src/a.ts` });
    expect(p('../other/b.md')).toEqual({ target: '/Users/me/other/b.md' });
  });

  it('line and column from compilers, browsers and editors', () => {
    expect(p('src/a.ts:12:5')).toEqual({ target: `${cwd}/src/a.ts`, line: 12, col: 5 });
    expect(p('src/a.ts:12')).toEqual({ target: `${cwd}/src/a.ts`, line: 12 });
    expect(p('src/a.ts:12:5:')).toEqual({ target: `${cwd}/src/a.ts`, line: 12, col: 5 });
    expect(p('src/a.ts#L12')).toEqual({ target: `${cwd}/src/a.ts`, line: 12 });
    expect(p('src/a.ts#L12-L20')).toEqual({ target: `${cwd}/src/a.ts`, line: 12 });
    expect(p('src/a.ts(12,5)')).toEqual({ target: `${cwd}/src/a.ts`, line: 12, col: 5 });
  });

  it('absolute, home, and git-diff prefixes', () => {
    expect(p('/etc/hosts')).toEqual({ target: '/etc/hosts' });
    expect(p('~/notes.md')).toEqual({ target: '/Users/me/notes.md' });
    expect(p('a/src/x.ts')).toEqual({ target: `${cwd}/src/x.ts` });
    expect(p('b/src/x.ts')).toEqual({ target: `${cwd}/src/x.ts` });
  });

  it('urls pass through, trailing prose punctuation dropped', () => {
    expect(p('http://localhost:9003/')).toEqual({ target: 'http://localhost:9003/' });
    expect(p('see https://example.com/x.')).toBeNull(); // prose before a url is not a selection of a url
    expect(p('<https://example.com/x>')).toEqual({ target: 'https://example.com/x' });
  });

  it('refuses what is not one path', () => {
    expect(p('hello')).toBeNull();
    expect(p('two words.ts')).toBeNull();
    expect(p('')).toBeNull();
    expect(p('12:5')).toBeNull();
    expect(parsePathCandidate('src/a.ts', undefined)).toBeNull(); // relative with no cwd
    expect(parsePathCandidate('~/x', cwd, undefined)).toBeNull();
    expect(p('Makefile')).toEqual({ target: `${cwd}/Makefile` });
    expect(p('x'.repeat(500))).toBeNull();
  });
});
