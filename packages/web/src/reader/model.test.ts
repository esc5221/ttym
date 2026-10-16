import { describe, expect, it } from 'vitest';
import type { ReaderFeed, ReaderUpdate } from '@ttym/api';
import { MAX_BLOCKS, applyEarlier, attachSummaries, applyFeed, emptyState, formatDuration, interrupted, pendingMessages, turnStartedAt } from './model.js';

const feed = (updates: ReaderUpdate[], over: Partial<ReaderFeed> = {}): ReaderFeed =>
  ({ agent: 'claude-code', supported: true, key: 'k1', next: 100, reset: true, from: 0, updates, ...over });
const user = (id: string, at: number, text = id): ReaderUpdate => ({ op: 'user', id, at, text });
const tool = (id: string, at: number, extra: Partial<Extract<ReaderUpdate, { op: 'tool' }>> = {}): ReaderUpdate =>
  ({ op: 'tool', id, at, name: 'Bash', target: 'ls', input: 'ls', ...extra });

describe('applyFeed', () => {
  it('builds blocks from a first answer', () => {
    const s = applyFeed(emptyState(), feed([user('u1', 1, 'hi'), { op: 'text', id: 'a1', at: 2, text: 'hello' }, { op: 'title', text: 'Greeting' }]));
    expect(s.blocks.map((b) => b.kind)).toEqual(['user', 'text']);
    expect(s).toMatchObject({ key: 'k1', next: 100, supported: true, agent: 'claude-code', title: 'Greeting' });
  });

  it('appends on a continuation and keeps the earlier blocks', () => {
    const a = applyFeed(emptyState(), feed([user('u1', 1)]));
    const b = applyFeed(a, feed([user('u2', 2)], { reset: false, next: 200 }));
    expect(b.blocks.map((x) => x.id)).toEqual(['u1', 'u2']);
    expect(b.next).toBe(200);
  });

  it('replaces everything on a reset', () => {
    const a = applyFeed(emptyState(), feed([user('u1', 1)]));
    const b = applyFeed(a, feed([user('x1', 5)], { key: 'k2' }));
    expect(b.blocks.map((x) => x.id)).toEqual(['x1']);
    expect(b.key).toBe('k2');
  });

  it('returns the same state when nothing changed, so the page does not re-render', () => {
    const a = applyFeed(emptyState(), feed([user('u1', 1)]));
    expect(applyFeed(a, feed([], { reset: false, next: 100 }))).toBe(a);
  });

  it('ignores an update delivered twice', () => {
    const a = applyFeed(emptyState(), feed([user('u1', 1)]));
    const b = applyFeed(a, feed([user('u1', 1)], { reset: false, next: 120 }));
    expect(b.blocks).toHaveLength(1);
  });

  describe('tools', () => {
    it('shows a call as running until its result arrives, then joins them by id', () => {
      const a = applyFeed(emptyState(), feed([tool('t1', 10)]));
      expect(a.blocks[0]).toMatchObject({ kind: 'tool', status: 'running', output: '' });

      const b = applyFeed(a, feed([{ op: 'tool-result', id: 't1', at: 14, output: 'done', isError: false }], { reset: false }));
      expect(b.blocks).toHaveLength(1);
      expect(b.blocks[0]).toMatchObject({ status: 'ok', output: 'done', endedAt: 14, target: 'ls' });
    });

    it('marks an error and keeps the patch from the call unless the result brings a better one', () => {
      const call = { file: '/a.rs', hunks: [{ header: '', lines: [{ op: '+' as const, text: 'x' }] }] };
      const better = { file: '/a.rs', hunks: [{ header: '@@ -1,1 +1,1 @@', lines: [{ op: ' ' as const, text: 'ctx' }] }] };
      const a = applyFeed(emptyState(), feed([tool('t1', 1, { name: 'Edit', patch: call })]));
      const failed = applyFeed(a, feed([{ op: 'tool-result', id: 't1', at: 2, output: 'no match', isError: true }], { reset: false }));
      expect(failed.blocks[0]).toMatchObject({ status: 'error', patch: call });
      const ok = applyFeed(a, feed([{ op: 'tool-result', id: 't1', at: 2, output: '', isError: false, patch: better }], { reset: false }));
      expect(ok.blocks[0]).toMatchObject({ status: 'ok', patch: better });
    });

    it('drops a result whose call we do not hold', () => {
      const s = applyFeed(emptyState(), feed([{ op: 'tool-result', id: 'gone', at: 1, output: 'x', isError: false }]));
      expect(s.blocks).toEqual([]);
    });
  });

  describe('turn end', () => {
    it('counts the turn’s tools and the files it edited, and stops at the prompt before it', () => {
      const edit = { file: '/a.rs', hunks: [] };
      const s = applyFeed(emptyState(), feed([
        user('u0', 1), tool('old', 2), { op: 'turn-end', id: 'e0', at: 3, durationMs: 1000 },
        user('u1', 10), tool('t1', 11), tool('t2', 12, { name: 'Edit', patch: edit }), tool('t3', 13, { name: 'Edit', patch: { file: '/b.rs', hunks: [] } }),
        { op: 'tool-result', id: 't3', at: 14, output: 'err', isError: true },
        { op: 'turn-end', id: 'e1', at: 15, durationMs: 221_000 },
      ]));
      const end = s.blocks.find((b) => b.id === 'e1');
      expect(end).toMatchObject({ kind: 'turn-end', durationMs: 221_000, tools: 3, edited: ['/a.rs'] });
      expect(s.blocks.find((b) => b.id === 'e0')).toMatchObject({ tools: 1, edited: [] });
    });

    it('knows when the turn in progress began', () => {
      const done = applyFeed(emptyState(), feed([user('u1', 5), { op: 'turn-end', id: 'e', at: 6, durationMs: 1 }]));
      expect(turnStartedAt(done)).toBeNull();
      const running = applyFeed(done, feed([user('u2', 9), tool('t', 10)], { reset: false }));
      expect(turnStartedAt(running)).toBe(9);
    });
  });

  describe('interruption', () => {
    const stop: ReaderUpdate = { op: 'notice', id: 'n1', at: 20, text: 'Request interrupted by user', endsTurn: true };

    it('says the turn is over until something new is sent', () => {
      const cut = applyFeed(emptyState(), feed([user('u1', 10), tool('t1', 11), stop]));
      expect(interrupted(cut)).toBe(true);
      expect(turnStartedAt(cut)).toBeNull();
      const again = applyFeed(cut, feed([user('u2', 30)], { reset: false }));
      expect(interrupted(again)).toBe(false);
      expect(turnStartedAt(again)).toBe(30);
    });

    it('shows a prompt that was cut off and sent again, longer, once', () => {
      const s = applyFeed(emptyState(), feed([user('u1', 10, 'fix the height'), stop, user('u2', 70, 'fix the height. also the drag')]));
      expect(s.blocks.filter((b) => b.kind === 'user').map((b) => b.id)).toEqual(['u2']);
    });

    it('keeps two different prompts, and two identical ones with no interruption between', () => {
      const a = applyFeed(emptyState(), feed([user('u1', 10, 'one'), stop, user('u2', 70, 'two')]));
      expect(a.blocks.filter((b) => b.kind === 'user')).toHaveLength(2);
      const b = applyFeed(emptyState(), feed([user('u1', 10, 'again'), user('u2', 70, 'again')]));
      expect(b.blocks.filter((x) => x.kind === 'user')).toHaveLength(2);
    });

    it('does not count an ordinary notice as an interruption', () => {
      const s = applyFeed(emptyState(), feed([user('u1', 10), { op: 'notice', id: 'n2', at: 12, text: 'Task finished' }]));
      expect(interrupted(s)).toBe(false);
    });
  });

  describe('queue', () => {
    const enq = (text: string | undefined, system = false): ReaderUpdate => ({ op: 'queue', at: 1, action: 'enqueue', text, system });
    const deq: ReaderUpdate = { op: 'queue', at: 2, action: 'dequeue' };

    it('lists what the person queued and hides what the agent queued for itself', () => {
      const s = applyFeed(emptyState(), feed([enq('fix the README'), enq('<task-notification>', true)]));
      expect(pendingMessages(s)).toEqual(['fix the README']);
    });

    it('lets a dequeue take what the person typed before what the agent queued for itself', () => {
      const s = applyFeed(emptyState(), feed([enq('<task-notification>', true), enq('mine'), deq]));
      expect(pendingMessages(s)).toEqual([]);
      expect(s.queue.map((q) => q.system)).toEqual([true]);
    });

    it('takes the oldest entry when only the agent’s own are left', () => {
      const s = applyFeed(emptyState(), feed([enq('<a>', true), enq('<b>', true), deq]));
      expect(s.queue.map((q) => q.text)).toEqual(['<b>']);
    });

    it('drops an entry removed by name, and the person’s own when they take them back', () => {
      const rm = (text: string): ReaderUpdate => ({ op: 'queue', at: 3, action: 'remove', text });
      const s = applyFeed(emptyState(), feed([enq('<a>', true), enq('keep'), enq('<b>', true), rm('<a>'), rm('not there')]));
      expect(s.queue.map((q) => q.text)).toEqual(['keep', '<b>']);
      const cleared = applyFeed(s, feed([{ op: 'queue', at: 4, action: 'clear' }], { reset: false }));
      expect(cleared.queue.map((q) => q.text)).toEqual(['<b>']);
    });

    it('stops showing a message as waiting once it is on the page as a prompt', () => {
      // the queue never said it left (a missed dequeue), but the prompt itself arrived
      const s = applyFeed(emptyState(), feed([enq('현황 체크'), enq('<n>', true), user('u1', 5, '현황 체크 ')]));
      expect(pendingMessages(s)).toEqual([]);
      expect(s.queue).toHaveLength(1);
    });

    it('matches a long message by its start', () => {
      const long = 'x'.repeat(400);
      const s = applyFeed(emptyState(), feed([enq(`${'x'.repeat(299)}…`), user('u1', 5, long)]));
      expect(pendingMessages(s)).toEqual([]);
    });

    it('does not fail on a dequeue with nothing queued', () => {
      expect(applyFeed(emptyState(), feed([deq])).queue).toEqual([]);
    });
  });

  it('keeps only the newest blocks of a very long conversation', () => {
    const many = Array.from({ length: MAX_BLOCKS + 50 }, (_, i) => user(`u${i}`, i));
    const s = applyFeed(emptyState(), feed(many));
    expect(s.blocks).toHaveLength(MAX_BLOCKS);
    expect(s.blocks[0].id).toBe('u50');
  });

  it('records that an agent has no parser yet', () => {
    const s = applyFeed(emptyState(), feed([], { agent: 'codex', supported: false, key: null, next: 0 }));
    expect(s).toMatchObject({ agent: 'codex', supported: false, blocks: [] });
  });
});

describe('formatDuration', () => {
  it.each([[400, '<1s'], [42_000, '42s'], [221_000, '3m 41s'], [3_720_000, '1h 2m']])('%i ms → %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe('earlier history', () => {
  const asked = (updates: ReaderUpdate[], from: number) => feed(updates, { reset: false, from, next: 50 });

  it('remembers where the first load began, and how to ask for what is above it', () => {
    expect(applyFeed(emptyState(), feed([user('u9', 9)], { from: 4000 })).earlier).toBe(4000);
    expect(applyFeed(emptyState(), feed([user('u9', 9)], { from: 0 })).earlier).toBeNull();
  });

  it('puts the older page in front, and says when the start has been reached', () => {
    const now = applyFeed(emptyState(), feed([user('u3', 3), user('u4', 4)], { from: 4000 }));
    const older = applyEarlier(now, asked([user('u1', 1), { op: 'text', id: 'a1', at: 2, text: 'hi' }], 0));
    expect(older.blocks.map((b) => b.id)).toEqual(['u1', 'a1', 'u3', 'u4']);
    expect(older.earlier).toBeNull();
    expect(older.next).toBe(now.next);
  });

  it('joins a result that arrived before its call was loaded', () => {
    const now = applyFeed(emptyState(), feed([{ op: 'tool-result', id: 't1', at: 6, output: 'ok', isError: false }, user('u3', 3)], { from: 4000 }));
    expect(now.blocks.map((b) => b.id)).toEqual(['u3']);
    const older = applyEarlier(now, asked([tool('t1', 5)], 2000));
    expect(older.blocks[0]).toMatchObject({ id: 't1', status: 'ok', output: 'ok' });
    expect(older.earlier).toBe(2000);
    expect(older.orphans).toEqual({});
  });

  it('ignores a page that belongs to a record we are no longer showing', () => {
    const now = applyFeed(emptyState(), feed([user('u3', 3)], { from: 4000 }));
    expect(applyEarlier(now, { ...asked([user('u1', 1)], 0), key: 'other' })).toBe(now);
  });

  it('does not take what was queued or titled back then as current', () => {
    const now = applyFeed(emptyState(), feed([user('u3', 3)], { from: 4000, key: 'k1' }));
    const older = applyEarlier(now, asked([{ op: 'queue', at: 1, action: 'enqueue', text: 'old' }, { op: 'title', text: 'Old' }, user('u1', 1)], 0));
    expect(older.queue).toEqual([]);
    expect(older.title).toBeNull();
  });
});

describe('rolled-back branches', () => {
  const link = (entry: string, parent: string | null): ReaderUpdate => ({ op: 'link', entry, parent });
  const u = (id: string, entry: string, text = id): ReaderUpdate => ({ op: 'user', id, at: 1, text, entry });
  const a = (id: string, entry: string): ReaderUpdate => ({ op: 'text', id, at: 2, text: id, entry });
  const ids = (s: ReturnType<typeof applyFeed>) => s.blocks.map((b) => b.id);

  it('hides what was taken back when the conversation went on from an earlier point', () => {
    // one → answer → (two → answer2 abandoned) ; three continues from the answer
    const s = applyFeed(emptyState(), feed([
      link('e1', null), u('one', 'e1'), link('e2', 'e1'), a('ans1', 'e2'),
      link('e3', 'e2'), u('two', 'e3'), link('e4', 'e3'), a('ans2', 'e4'),
      link('e5', 'e2'), u('three', 'e5'), link('e6', 'e5'), a('ans3', 'e6'),
    ]));
    expect(ids(s)).toEqual(['one', 'ans1', 'three', 'ans3']);
    expect(s.raw.map((b) => b.id)).toEqual(['one', 'ans1', 'two', 'ans2', 'three', 'ans3']);
  });

  it('hides a message from the moment it is taken back, on a later poll', () => {
    const first = applyFeed(emptyState(), feed([link('e1', null), u('one', 'e1'), link('e2', 'e1'), u('mistyped', 'e2')]));
    expect(ids(first)).toEqual(['one', 'mistyped']);
    const then = applyFeed(first, feed([link('e3', 'e1'), u('retyped', 'e3')], { reset: false, next: 200 }));
    expect(ids(then)).toEqual(['one', 'retyped']);
  });

  it('keeps every line of descent: history from before a compaction stays', () => {
    const s = applyFeed(emptyState(), feed([
      link('a1', null), u('old', 'a1'), link('a2', 'a1'), a('olda', 'a2'),
      link('b1', null), { op: 'boundary', id: 'bd', at: 1, label: 'compacted', entry: 'b1' }, link('b2', 'b1'), u('new', 'b2'),
    ]));
    expect(ids(s)).toEqual(['old', 'olda', 'bd', 'new']);
  });

  it('shows what the log says nothing about, and what a window cut off from its parent', () => {
    const s = applyFeed(emptyState(), feed([
      u('plain', 'unlinked'), link('w2', 'outside-the-window'), u('inwindow', 'w2'),
    ]));
    expect(ids(s)).toEqual(['plain', 'inwindow']);
  });

  it('counts a turn’s tools from its own branch', () => {
    const t = (id: string, entry: string): ReaderUpdate => ({ op: 'tool', id, at: 1, name: 'Bash', target: id, input: '', entry });
    const s = applyFeed(emptyState(), feed([
      link('e1', null), u('go', 'e1'), link('e2', 'e1'), t('dead-tool', 'e2'),
      link('e3', 'e1'), t('live-tool', 'e3'), link('e4', 'e3'), { op: 'turn-end', id: 'end', at: 5, durationMs: 1000, entry: 'e4' },
    ]));
    expect(ids(s)).toEqual(['go', 'live-tool', 'end']);
    expect(s.blocks.find((b) => b.id === 'end')).toMatchObject({ tools: 1 });
  });

  it('joins the links of an older page, so history above can be told dead or alive too', () => {
    const now = applyFeed(emptyState(), feed([link('e5', 'e2'), u('three', 'e5')], { from: 4000 }));
    expect(ids(now)).toEqual(['three']);
    const older = applyEarlier(now, feed([link('e1', null), u('one', 'e1'), link('e2', 'e1'), a('ans1', 'e2'), link('e3', 'e2'), u('two', 'e3')], { reset: false, from: 0, next: 50 }));
    expect(ids(older)).toEqual(['one', 'ans1', 'three']);
    expect(older.raw.map((b) => b.id)).toContain('two');
  });

  it('does not treat an interruption that was rolled back as the last word', () => {
    const s = applyFeed(emptyState(), feed([
      link('e1', null), u('go', 'e1'), link('e2', 'e1'), { op: 'notice', id: 'stop', at: 3, text: 'Request interrupted by user', endsTurn: true, entry: 'e2' },
      link('e3', 'e1'), u('again', 'e3'),
    ]));
    expect(interrupted(s)).toBe(false);
    expect(ids(s)).toEqual(['go', 'again']);
  });
});

describe('attachSummaries', () => {
  const b = (updates: ReaderUpdate[]) => applyFeed(emptyState(), feed(updates)).blocks;

  it('moves the summary after a boundary into it', () => {
    const out = attachSummaries(b([{ op: 'text', id: 'a', at: 1, text: 'x' }, { op: 'boundary', id: 'c', at: 2, label: 'compacted' }, { op: 'summary', id: 's', at: 3, text: 'what happened' }, user('u', 4)]));
    expect(out.map((x) => x.kind)).toEqual(['text', 'boundary', 'user']);
    expect(out[1]).toMatchObject({ summary: 'what happened' });
  });

  it('leaves a summary with no boundary before it', () => {
    expect(attachSummaries(b([user('u', 1), { op: 'summary', id: 's', at: 2, text: 't' }])).map((x) => x.kind)).toEqual(['user', 'summary']);
  });

  it('is not a turn start: a summary does not count as something the person said', () => {
    const s = applyFeed(emptyState(), feed([user('u', 5), { op: 'summary', id: 's', at: 9, text: 't' }]));
    expect(turnStartedAt(s)).toBe(5);
  });
});
