import { describe, expect, it } from 'vitest';
import { idsOf, liveVisible, sameWords, splitMarkdown, type LiveText } from './live.js';
import type { Block } from './model.js';

const text = (id: string, t: string): Block => ({ kind: 'text', id, at: 1, text: t });
const user = (id: string): Block => ({ kind: 'user', id, at: 1, text: 'hi', images: 0 });

describe('splitMarkdown', () => {
  it('closes a paragraph only after the line that follows it', () => {
    expect(splitMarkdown('first\n\n')).toEqual({ closed: [], open: 'first\n\n' });
    expect(splitMarkdown('first\n\nsecond\n')).toEqual({ closed: ['first'], open: 'second\n' });
  });
  it('keeps a code fence whole across blank lines', () => {
    const t = '```js\na\n\nb\n```\n\nafter\n';
    expect(splitMarkdown(t)).toEqual({ closed: ['```js\na\n\nb\n```'], open: 'after\n' });
    expect(splitMarkdown('```js\na\n\nb')).toEqual({ closed: [], open: '```js\na\n\nb' });
  });
  it('keeps a list together, and an indented continuation with its item', () => {
    expect(splitMarkdown('1. a\n\n2. b\n\npara\n').closed).toEqual(['1. a\n\n2. b']);
    expect(splitMarkdown('- a\n\n  more of a\n\nnext\n').closed).toEqual(['- a\n\n  more of a']);
  });
  it('does not close a block on a line that is still being written', () => {
    expect(splitMarkdown('- i\n\n-').closed).toEqual([]);
    expect(splitMarkdown('- i\n\n- j\n').closed).toEqual([]);
  });
  it('never changes a closed block when more text arrives', () => {
    const full = 'a\n\nb\n\n```\nx\n\ny\n```\n\n- i\n\n- j\n\nlast line\n';
    let prev: string[] = [];
    for (let n = 1; n <= full.length; n++) {
      const { closed } = splitMarkdown(full.slice(0, n));
      expect(closed.slice(0, prev.length)).toEqual(prev);
      prev = closed;
    }
    expect(prev).toEqual(['a', 'b', '```\nx\n\ny\n```', '- i\n\n- j']);
  });
});

describe('sameWords', () => {
  it('compares words, not characters: bold marks, fence tags and table bars do not count', () => {
    expect(sameWords('Octopuses have chromatophores and iridophores', 'Octopuses have **chromatophores** and `iridophores`')).toBe(true);
    expect(sameWords('Some text\n\n```\nx = 1', 'Some text\n\n```python\nx = 1\n```')).toBe(true);
  });
  it('matches by the start, so a message still being written matches its finished record', () => {
    expect(sameWords('The answer starts here and', 'The answer starts here and goes on for a long time after')).toBe(true);
    expect(sameWords('A different start entirely', 'The answer starts here')).toBe(false);
  });
  it('does not match on a few words', () => {
    expect(sameWords('Yes.', 'Yes. And more')).toBe(false);
  });
});

describe('liveVisible', () => {
  const live = (over: Partial<LiveText> = {}): LiveText => ({ mid: '1', text: 'The answer is here.', done: false, ...over });
  it('shows a message the record does not have yet, and not an empty one', () => {
    expect(liveVisible(live(), [user('u')], idsOf([user('u')]))).toBe(true);
    expect(liveVisible(live({ text: '  \n' }), [], new Set())).toBe(false);
    expect(liveVisible(null, [], new Set())).toBe(false);
  });
  it('goes once the record has the message', () => {
    const seen = idsOf([user('u')]);
    expect(liveVisible(live({ done: true }), [user('u'), text('t', 'The **answer** is here.')], seen)).toBe(false);
    expect(liveVisible(live({ done: false }), [user('u'), text('t', 'The answer is here. And on it goes.')], seen)).toBe(false);
    expect(liveVisible(live({ done: true }), [user('u'), text('t', 'Something else entirely')], seen)).toBe(true);
  });
  it('goes when the turn moved on without it', () => {
    const seen = idsOf([user('u')]);
    expect(liveVisible(live(), [user('u'), { kind: 'notice', id: 'n', at: 2, text: 'Interrupted', endsTurn: true }], seen)).toBe(false);
    expect(liveVisible(live(), [user('u'), user('u2')], seen)).toBe(false);
  });
  it('does not show a finished message again when the record already had it before the page saw it', () => {
    const blocks = [user('u'), text('t', 'The answer is here.')];
    expect(liveVisible(live({ done: true }), blocks, idsOf(blocks))).toBe(false);
  });
});
