import { describe, expect, it } from 'vitest';
import { OutputRing } from './output-ring.js';

describe('OutputRing', () => {
  it('tracks sequence numbers and returns chunks after a sequence', () => {
    const ring = new OutputRing(1024);

    const seq1 = ring.push(Buffer.from('a'));
    const seq2 = ring.push(Buffer.from('bc'));

    expect(seq1).toBe(1);
    expect(seq2).toBe(2);
    expect(ring.baseSeq).toBe(1);
    expect(ring.nextSeq).toBe(3);
    expect(ring.byteSize).toBe(3);
    expect(ring.since(1).map((chunk) => chunk.data.toString())).toEqual(['bc']);
  });

  it('evicts the oldest chunks when maxBytes is exceeded', () => {
    const ring = new OutputRing(5);

    ring.push(Buffer.from('ab'));
    ring.push(Buffer.from('cd'));
    const seq = ring.push(Buffer.from('ef'));

    expect(seq).toBe(3);
    expect(ring.baseSeq).toBe(2);
    expect(ring.nextSeq).toBe(4);
    expect(ring.byteSize).toBe(4);
    expect(ring.canReplaySince(1)).toBe(true);
    expect(ring.canReplaySince(0)).toBe(false);
    expect(ring.since(1).map((chunk) => chunk.seq)).toEqual([2, 3]);
  });

  it('trims acknowledged chunks and resets cleanly', () => {
    const ring = new OutputRing(1024);

    ring.push(Buffer.from('ab'));
    ring.push(Buffer.from('cd'));
    ring.push(Buffer.from('ef'));

    ring.trimTo(2);

    expect(ring.baseSeq).toBe(3);
    expect(ring.byteSize).toBe(2);
    expect(ring.since(0).map((chunk) => chunk.seq)).toEqual([3]);

    ring.clear();

    expect(ring.byteSize).toBe(0);
    expect(ring.since(0)).toEqual([]);
    expect(ring.nextSeq).toBe(4);
    expect(ring.baseSeq).toBe(3);
  });
});
