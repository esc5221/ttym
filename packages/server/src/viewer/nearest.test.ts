import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findNearest, stripTrailingParticle, NEAREST_MAX_MS } from './nearest.js';

let root = '';
const file = (rel: string) => { const p = join(root, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, 'x'); return p; };
const dir = (rel: string) => { const p = join(root, rel); mkdirSync(p, { recursive: true }); return p; };

beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'ttym-near-'))); });
afterEach(() => { try { rmSync(root, { recursive: true }); } catch {} });

describe('the misses from the log', () => {
  it('a truncated head: /turing/suite/FEATURES/x/7.html → cwd/FEATURES/x/7.html', async () => {
    const real = file('FEATURES/260904_x/7.IA_v2.html');
    const r = await findNearest('/turing/suite/FEATURES/260904_x/7.IA_v2.html', root);
    expect(r).toMatchObject({ kind: 'hit', path: real, score: 3 });
  });
  it('missing middle folders: cwd/9.html → cwd/FEATURES/x/9.html', async () => {
    const real = file('FEATURES/260904_x/9.IA_v3.html');
    const r = await findNearest(join(root, '9.IA_v3.html'), root);
    expect(r).toMatchObject({ kind: 'hit', path: real, score: 1 });
  });
  it('one missing folder: cwd/260904_x/10.html → cwd/FEATURES/260904_x/10.html', async () => {
    const real = file('FEATURES/260904_x/10.IA_v4.html');
    const r = await findNearest(join(root, '260904_x/10.IA_v4.html'), root);
    expect(r).toMatchObject({ kind: 'hit', path: real, score: 2 });
  });
});

describe('no guessing', () => {
  it('two files with the same name and equal tail agreement → ambiguous, not opened', async () => {
    file('a/report-final.html');
    file('b/report-final.html');
    const r = await findNearest(join(root, 'report-final.html'), root);
    expect(r.kind).toBe('ambiguous');
    expect((r as { candidates: string[] }).candidates).toHaveLength(2);
  });
  it('a longer tail breaks the tie', async () => {
    file('a/report-final.html');
    const real = file('b/report-final.html');
    const r = await findNearest(join(root, 'zzz/b/report-final.html'), root);
    expect(r).toMatchObject({ kind: 'hit', path: real, score: 2 });
  });
  it('a generic name needs its parent to agree', async () => {
    file('site/index.html');
    expect((await findNearest(join(root, 'nope/index.html'), root)).kind).toBe('none');
    const r = await findNearest(join(root, 'x/site/index.html'), root);
    expect(r).toMatchObject({ kind: 'hit', score: 2 });
  });
  it('never looks inside node_modules or dot-dirs', async () => {
    file('node_modules/pkg/thing.md');
    file('.hidden/thing.md');
    expect((await findNearest(join(root, 'thing.md'), root)).kind).toBe('none');
  });
  it('stops at the time cap and says so', async () => {
    for (let i = 0; i < 40; i++) file(`d${i}/e/f/g.txt`);
    let t = 0;
    const r = await findNearest(join(root, 'zzz.txt'), root, { now: () => (t += NEAREST_MAX_MS), locate: async () => [] });
    expect(r).toMatchObject({ kind: 'none', capped: true });
  });
  it('the existing head of the request is the root when it is deeper than the cwd', async () => {
    const real = file('deep/er/x/leaf.md');
    file('elsewhere/leaf.md');
    const r = await findNearest(join(root, 'deep/er/wrong/leaf.md'), root);
    expect(r).toMatchObject({ kind: 'hit', path: real });
  });
});

describe('relative to a deeper cwd', () => {
  it('cwd/some.css → the one some.css below cwd', async () => {
    const real = file('web/styles/some.css');
    const r = await findNearest(join(root, 'web/some.css'), join(root, 'web'));
    expect(r).toMatchObject({ kind: 'hit', path: real });
  });
  it('a repo-relative path from a cwd below the file climbs to the .git root', async () => {
    mkdirSync(join(root, '.git'));
    const real = file('web/styles/some.css');
    mkdirSync(join(root, 'web/styles/sub'), { recursive: true });
    const cwd = join(root, 'web/styles/sub');
    const r = await findNearest(join(cwd, 'web/styles/some.css'), cwd);
    expect(r).toMatchObject({ kind: 'hit', path: real, score: 3 });
  });
  it('without a .git above, a deeper cwd stays a miss', async () => {
    file('web/styles/some.css');
    mkdirSync(join(root, 'web/styles/sub'), { recursive: true });
    const cwd = join(root, 'web/styles/sub');
    expect((await findNearest(join(cwd, 'some.css'), cwd)).kind).toBe('none');
  });
});

describe('an existing head that is the wrong one', () => {
  it('~/mainpy/output/playwright/x.png when the file is under ~/mainpy/sunken/output/playwright: the cwd is tried next', async () => {
    dir('output');
    const real = file('sunken/output/playwright/04-gameplay.png');
    const r = await findNearest(join(root, 'output/playwright/04-gameplay.png'), root);
    expect(r).toMatchObject({ kind: 'hit', path: real, score: 3 });
  });
  it('then the .git root, when the cwd is below the file', async () => {
    mkdirSync(join(root, '.git'));
    dir('web/out');
    const real = file('web/dist/out/x.js');
    const cwd = dir('web/styles');
    expect(await findNearest(join(cwd, 'out/x.js'), cwd)).toMatchObject({ kind: 'hit', path: real, score: 2 });
  });
});

describe('the walk is guided by the segments asked for', () => {
  const bulk = () => { for (let i = 0; i < 300; i++) file(`aaa/out/raw/f${i}.bin`); };
  it('…/playwright/x.png reaches the playwright folder before a dump next door exhausts the budget', async () => {
    bulk();
    const real = file('zzz/output/playwright/x.png');
    const r = await findNearest(join(root, 'playwright/x.png'), root, { maxEntries: 100, locate: async () => [] });
    expect(r).toMatchObject({ kind: 'hit', path: real });
  });
  it('a name alone, with the same budget, is capped — and reported as such', async () => {
    bulk();
    file('zzz/output/playwright/x.png');
    const r = await findNearest(join(root, 'x.png'), root, { maxEntries: 100, locate: async () => [] });
    expect(r).toMatchObject({ kind: 'none', capped: true });
  });
});

describe('directories', () => {
  it('a folder is found by its name like a file is', async () => {
    const real = dir('paper/figures');
    file('paper/figures/a.png');
    expect(await findNearest(join(root, 'figures'), root)).toMatchObject({ kind: 'hit', path: real });
  });
  it('many folders of that name → ambiguous', async () => {
    dir('a/figures'); dir('b/figures');
    expect((await findNearest(join(root, 'figures'), root)).kind).toBe('ambiguous');
  });
  it('a generic folder name (src, dist, output) needs its parent, like index.html does', async () => {
    dir('proj/dist');
    expect((await findNearest(join(root, 'dist'), root)).kind).toBe('none');
    expect(await findNearest(join(root, 'x/proj/dist'), root)).toMatchObject({ kind: 'hit', score: 2 });
  });
});

describe('when the walk is cut short, the index answers', () => {
  // A clock that is already past the cap on the first check: the walk yields at once.
  const clock = () => { let t = 0; return () => (t += NEAREST_MAX_MS + 1); };
  const capped = { get now() { return clock(); } };
  it('one path from the index with an agreeing tail opens', async () => {
    const real = file('deep/x/leaf.md');
    const r = await findNearest(join(root, 'x/leaf.md'), root, { ...capped, locate: async () => [real] });
    expect(r).toMatchObject({ kind: 'hit', path: real, score: 2 });
  });
  it('the index is filtered like the walk: exact name, no node_modules, generic names need a parent', async () => {
    const nm = join(root, 'node_modules/p/leaf.md');
    const near = join(root, 'a/leaf.md.bak');
    const r = await findNearest(join(root, 'leaf.md'), root, { ...capped, locate: async () => [nm, near] });
    expect(r).toMatchObject({ kind: 'none', capped: true });
    const idx = join(root, 'site/index.html');
    expect((await findNearest(join(root, 'index.html'), root, { ...capped, locate: async () => [idx] })).kind).toBe('none');
    expect(await findNearest(join(root, 'site/index.html'), root, { ...capped, locate: async () => [idx] })).toMatchObject({ kind: 'hit', path: idx });
  });
  it('two equal answers from the index → ambiguous', async () => {
    const r = await findNearest(join(root, 'leaf.md'), root, { ...capped, locate: async () => [join(root, 'a/leaf.md'), join(root, 'b/leaf.md')] });
    expect(r.kind).toBe('ambiguous');
  });
  it('a walk that finishes never asks the index', async () => {
    let asked = 0;
    file('a/leaf.md');
    await findNearest(join(root, 'leaf.md'), root, { locate: async () => { asked++; return []; } });
    expect(asked).toBe(0);
  });
});

describe('a particle glued to the extension', () => {
  it('drops one to three Hangul syllables after an extension, nothing else', () => {
    expect(stripTrailingParticle('/p/plans/260904_ADR.html에')).toBe('/p/plans/260904_ADR.html');
    expect(stripTrailingParticle('/p/a.md입니다')).toBe('/p/a.md');
    expect(stripTrailingParticle('/p/260904_인터랙티브/a.html')).toBe('/p/260904_인터랙티브/a.html');
    expect(stripTrailingParticle('/p/보고서.md')).toBe('/p/보고서.md');
    expect(stripTrailingParticle('/p/a.html에있는파일')).toBe('/p/a.html에있는파일');
    expect(stripTrailingParticle('/p/폴더에')).toBe('/p/폴더에');
  });
});
