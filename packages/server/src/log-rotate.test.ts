import { afterEach, describe, expect, it } from 'vitest';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rotateLogIfNeeded } from './log-rotate.js';

describe('log rotation', () => {
  let dir = '';
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function setup(content: string): string {
    dir = mkdtempSync(join(tmpdir(), 'ttym-rotate-'));
    const log = join(dir, 'ttym.log');
    writeFileSync(log, content);
    return log;
  }

  it('leaves a small log alone', async () => {
    const log = setup('little\n');
    expect(await rotateLogIfNeeded(log, 1024)).toBe(false);
    expect(readFileSync(log, 'utf8')).toBe('little\n');
  });

  it('archives and truncates once over the limit', async () => {
    const log = setup('x'.repeat(2048));
    expect(await rotateLogIfNeeded(log, 1024)).toBe(true);
    expect(statSync(log).size).toBe(0);
    expect(statSync(`${log}.1`).size).toBe(2048);
  });

  it('does not disturb a writer holding an append fd — the holder case', async () => {
    const log = setup('old '.repeat(512));
    // A holder's fd: opened with 'a' once at spawn, long before any rotation.
    const fd = openSync(log, 'a');
    try {
      await rotateLogIfNeeded(log, 1024);
      // The same fd keeps working, and its write lands in the truncated file,
      // not at a stale offset past the end.
      writeSync(fd, 'after rotation\n');
      expect(readFileSync(log, 'utf8')).toBe('after rotation\n');
    } finally {
      closeSync(fd);
    }
  });

  it('overwrites the previous archive rather than accumulating', async () => {
    const log = setup('first'.repeat(300));
    await rotateLogIfNeeded(log, 1024);
    writeFileSync(log, 'second'.repeat(300));
    await rotateLogIfNeeded(log, 1024);
    expect(readFileSync(`${log}.1`, 'utf8')).toContain('second');
    expect(readFileSync(`${log}.1`, 'utf8')).not.toContain('first');
  });

  it('reports false when there is no log at all', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ttym-rotate-'));
    expect(await rotateLogIfNeeded(join(dir, 'missing.log'), 1024)).toBe(false);
  });
});
