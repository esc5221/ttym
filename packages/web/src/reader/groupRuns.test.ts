import { describe, expect, it } from 'vitest';
import { groupRuns } from './model.js';
import type { Block } from './model.js';

const tool = (id: string) => ({ id, kind: 'tool', name: 'Read', target: id, status: 'ok' }) as unknown as Block;
const text = (id: string) => ({ id, kind: 'text', text: id }) as unknown as Block;

describe('groupRuns', () => {
  it('folds three or more consecutive tools, leaves shorter runs alone', () => {
    const out = groupRuns([text('a'), tool('1'), tool('2'), tool('3'), text('b'), tool('4'), tool('5')], true);
    expect(out.map((g) => (Array.isArray(g) ? g.length : g.id))).toEqual(['a', 3, 'b', '4', '5']);
  });
  it('does nothing when folding is off', () => {
    const blocks = [tool('1'), tool('2'), tool('3')];
    expect(groupRuns(blocks, false)).toEqual(blocks);
  });
});
