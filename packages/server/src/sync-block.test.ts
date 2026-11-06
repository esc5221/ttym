import { describe, expect, it } from 'vitest';
import { SyncBlockFilter } from './sync-block.js';

describe('SyncBlockFilter', () => {
  it('coalesces a synchronized block and strips the markers', () => {
    const filter = new SyncBlockFilter();
    const result = filter.process(Buffer.from('\x1b[?2026hhello\x1b[31mred\x1b[0m\x1b[?2026l', 'binary'));
    expect(result.syncStarted).toBe(true);
    expect(result.syncEnded).toBe(true);
    expect(result.syncOpen).toBe(false);
    expect(result.emitted).toHaveLength(1);
    expect(result.emitted[0]!.toString('binary')).toBe('hello\x1b[31mred\x1b[0m');
  });

  it('handles marker chunk splits correctly', () => {
    const filter = new SyncBlockFilter();
    let result = filter.process(Buffer.from('\x1b[?20', 'binary'));
    expect(result.emitted).toHaveLength(0);
    expect(result.syncOpen).toBe(false);

    result = filter.process(Buffer.from('26habc', 'binary'));
    expect(result.syncStarted).toBe(true);
    expect(result.syncOpen).toBe(true);
    expect(result.emitted).toHaveLength(0);

    result = filter.process(Buffer.from('\x1b[?2026l', 'binary'));
    expect(result.syncEnded).toBe(true);
    expect(result.emitted).toHaveLength(1);
    expect(result.emitted[0]!.toString('binary')).toBe('abc');
  });

  it('does not trigger on marker-like bytes inside OSC payloads', () => {
    const filter = new SyncBlockFilter();
    const result = filter.process(Buffer.from('\x1b]0;title \x1b[?2026h ignored\x07plain', 'binary'));
    expect(result.syncStarted).toBe(false);
    expect(result.syncObserved).toBe(false);
    expect(Buffer.concat(result.emitted).toString('binary')).toContain('\x1b]0;title \x1b[?2026h ignored\x07plain');
  });

  it('can abort an open block back to a raw payload', () => {
    const filter = new SyncBlockFilter();
    filter.process(Buffer.from('\x1b[?2026habc', 'binary'));
    const aborted = filter.abortOpenBlock();
    expect(aborted?.toString('binary')).toBe('abc');
    expect(filter.syncOpen).toBe(false);
  });

  it('keeps the order: text before, the block, text after (one PTY read)', () => {
    const r = new SyncBlockFilter().process(Buffer.from('PRE\x1b[?2026hINNER\x1b[?2026lPOST', 'binary'));
    expect(Buffer.concat(r.emitted).toString('binary')).toBe('PREINNERPOST');
  });

  it('keeps the order across two blocks and text in between', () => {
    const r = new SyncBlockFilter().process(Buffer.from('a\x1b[?2026hB1\x1b[?2026lc\x1b[?2026hB2\x1b[?2026ld', 'binary'));
    expect(Buffer.concat(r.emitted).toString('binary')).toBe('aB1cB2d');
  });

  it('emits one buffer per call that does not share the 8KB pool', () => {
    const r = new SyncBlockFilter().process(Buffer.from('x\x1b[1my\x1b[0m', 'binary'));
    expect(r.emitted).toHaveLength(1);
    expect(r.emitted[0]!.buffer.byteLength).toBe(r.emitted[0]!.length);
  });

  it('does not hold an unterminated OSC: it streams through', () => {
    const f = new SyncBlockFilter();
    const r = f.process(Buffer.from('\x1b]0;' + 'x'.repeat(1 << 20), 'binary'));
    expect(Buffer.concat(r.emitted).length).toBe(4 + (1 << 20));
    expect((f as unknown as { pending: number[] }).pending.length).toBe(0);
  });

  it('gives up on a CSI longer than any marker and passes it through intact', () => {
    const long = '\x1b[' + '1;'.repeat(100) + 'm';
    const r = new SyncBlockFilter().process(Buffer.from(long + 'z', 'binary'));
    expect(Buffer.concat(r.emitted).toString('binary')).toBe(long + 'z');
  });

  it('overflowing block falls back to raw bytes in order', () => {
    const f = new SyncBlockFilter();
    const big = 'q'.repeat(600 * 1024);
    const r = f.process(Buffer.from('A\x1b[?2026h' + big + 'B', 'binary'));
    expect(r.overflowed).toBe(true);
    expect(Buffer.concat(r.emitted).toString('binary')).toBe('A' + big + 'B');
  });

  it('any split of the input gives the same bytes as the unsplit input (markers removed)', () => {
    const input = Buffer.from('p\x1b[31mq\x1b]0;t\x07r\x1b[?2026hS\x1bPdcs\x1b\\T\x1b[?2026lu\x1b[?2026hV\x1b[?2026lw\x1bcx', 'binary');
    const whole = new SyncBlockFilter().process(input);
    const expected = Buffer.concat(whole.emitted).toString('binary');
    expect(expected).toBe('p\x1b[31mq\x1b]0;t\x07rS\x1bPdcs\x1b\\TuVw\x1bcx');
    for (let a = 0; a <= input.length; a++) {
      for (let b = a; b <= input.length; b++) {
        const f = new SyncBlockFilter();
        const parts = [input.subarray(0, a), input.subarray(a, b), input.subarray(b)];
        const got = Buffer.concat(parts.flatMap((p) => f.process(p).emitted)).toString('binary');
        expect(got, `split at ${a},${b}`).toBe(expected);
      }
    }
  });
});
