import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepRuntimeDir } from './run-gc.js';

const DAY = 24 * 60 * 60 * 1000;

describe('runtime dir sweep', () => {
  let dir = '';
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function file(name: string, ageDays = 0): string {
    const path = join(dir, name);
    writeFileSync(path, '{}');
    if (ageDays > 0) {
      const then = new Date(Date.now() - ageDays * DAY);
      utimesSync(path, then, then);
    }
    return path;
  }

  it('removes old unreferenced files and nothing else', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ttym-gc-'));
    const goneSnap = file('snapshot-100.json', 30);
    const goneMeta = file('meta-100.json', 30);
    const keptLive = file('snapshot-7.json', 30);      // referenced
    const keptYoung = file('snapshot-200.json', 3);    // unreferenced but recent
    const keptOther = file('workspaces.json', 400);    // out of scope entirely
    const keptManifest = file('session-100.json', 400); // recover()'s territory

    const result = await sweepRuntimeDir(dir, new Set([7]), 14 * DAY);

    expect(result.removed.sort()).toEqual(['meta-100.json', 'snapshot-100.json']);
    expect(existsSync(goneSnap)).toBe(false);
    expect(existsSync(goneMeta)).toBe(false);
    expect(existsSync(keptLive)).toBe(true);
    expect(existsSync(keptYoung)).toBe(true);
    expect(existsSync(keptOther)).toBe(true);
    expect(existsSync(keptManifest)).toBe(true);
  });

  it('handles a missing directory without complaint', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ttym-gc-'));
    const result = await sweepRuntimeDir(join(dir, 'nope'), new Set(), DAY);
    expect(result).toEqual({ removed: [], kept: 0 });
  });

  it('at production scale: sweeps the accumulation, keeps every referenced file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ttym-gc-'));
    // The captured shape: ~180 snapshots and ~240 metas, 15 referenced.
    const referenced = new Set<number>();
    for (let id = 1; id <= 15; id++) {
      referenced.add(id);
      file(`snapshot-${id}.json`, 30);
      file(`meta-${id}.json`, 30);
    }
    for (let id = 100; id < 265; id++) file(`snapshot-${id}.json`, 30);
    for (let id = 100; id < 326; id++) file(`meta-${id}.json`, 30);

    const result = await sweepRuntimeDir(dir, referenced, 14 * DAY);

    expect(result.removed.length).toBe(165 + 226);
    expect(result.kept).toBe(30);
    for (let id = 1; id <= 15; id++) {
      expect(existsSync(join(dir, `snapshot-${id}.json`))).toBe(true);
      expect(existsSync(join(dir, `meta-${id}.json`))).toBe(true);
    }
  });
});
