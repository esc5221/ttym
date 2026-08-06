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
});
