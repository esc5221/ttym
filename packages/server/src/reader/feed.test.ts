import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readNewLines } from './feed.js';

let dir: string;
let n = 0;
const fresh = (content = '') => { const p = join(dir, `t${n++}.jsonl`); writeFileSync(p, content); return p; };

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'ttym-feed-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('readNewLines', () => {
  it('takes the whole of a small file on the first ask', async () => {
    const r = await readNewLines(fresh('a\nb\nc\n'), null);
    expect(r).toEqual({ lines: ['a', 'b', 'c'], next: 6, reset: true });
  });

  it('continues from where the last answer ended', async () => {
    const p = fresh('a\nb\n');
    const first = await readNewLines(p, null);
    appendFileSync(p, 'c\nd\n');
    const second = await readNewLines(p, first.next);
    expect(second).toEqual({ lines: ['c', 'd'], next: 8, reset: false });
    expect(await readNewLines(p, second.next)).toEqual({ lines: [], next: 8, reset: false });
  });

  it('holds back a line the writer has not finished', async () => {
    const p = fresh('a\nb');
    const first = await readNewLines(p, null);
    expect(first).toEqual({ lines: ['a'], next: 2, reset: true });
    appendFileSync(p, '\nc');
    const second = await readNewLines(p, first.next);
    expect(second).toEqual({ lines: ['b'], next: 4, reset: false });
    appendFileSync(p, '\n');
    expect((await readNewLines(p, second.next)).lines).toEqual(['c']);
  });

  it('starts over when the file was rewritten shorter', async () => {
    const p = fresh('aaaa\nbbbb\n');
    writeFileSync(p, 'x\n');
    expect(await readNewLines(p, 10)).toEqual({ lines: ['x'], next: 2, reset: true });
  });

  it('takes only the tail on the first ask and drops the fragment it lands in', async () => {
    const p = fresh(['line-one', 'line-two', 'line-three', 'line-four'].join('\n') + '\n');
    const r = await readNewLines(p, null, { initialBytes: 22, maxBytes: 1000 });
    expect(r.lines).toEqual(['line-three', 'line-four']);
    expect(r.reset).toBe(true);
    expect(r.next).toBe(Buffer.byteLength('line-one\nline-two\nline-three\nline-four\n'));
  });

  it('starts over from the tail when the client is further behind than one read allows', async () => {
    const p = fresh(['aaaaaaaa', 'bbbbbbbb', 'cccccccc', 'dddddddd'].join('\n') + '\n');
    const r = await readNewLines(p, 0, { initialBytes: 18, maxBytes: 20 });
    expect(r.reset).toBe(true);
    expect(r.lines).toEqual(['cccccccc', 'dddddddd']);
  });

  it('keeps multi-byte text intact across a tail cut', async () => {
    const p = fresh('앞부분 한글\n둘째 줄\n셋째 줄\n');
    const r = await readNewLines(p, null, { initialBytes: 20, maxBytes: 1000 });
    expect(r.lines.every((l) => !l.includes('�'))).toBe(true);
    expect(r.lines.at(-1)).toBe('셋째 줄');
  });

  it('is empty, not an error, for an empty file', async () => {
    expect(await readNewLines(fresh(''), null)).toEqual({ lines: [], next: 0, reset: true });
  });
});
