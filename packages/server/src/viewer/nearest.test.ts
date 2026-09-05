import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findNearest, NEAREST_MAX_MS } from './nearest.js';

let root = '';
const file = (rel: string) => { const p = join(root, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, 'x'); return p; };

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
    const r = await findNearest(join(root, 'zzz.txt'), root, () => (t += NEAREST_MAX_MS));
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
