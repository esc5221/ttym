import { describe, expect, it } from 'vitest';
import { parseTurn, renderFull, renderOutline, summarize } from './agent-turn.js';

const T = (s: number) => new Date(Date.UTC(2026, 8, 27, 0, 0, s)).toISOString();
const line = (o: unknown) => JSON.stringify(o);
const JSONL = [
  line({ type: 'assistant', timestamp: T(1), message: { content: [{ type: 'text', text: 'old turn' }] } }),
  line({ type: 'user', timestamp: T(10), message: { content: '17*3?' } }),
  line({ type: 'assistant', timestamp: T(11), message: { content: [{ type: 'thinking', thinking: 'x' }] } }),
  line({ type: 'assistant', timestamp: T(12), message: { content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'python3 -c "print(17*3)"' } }] } }),
  line({ type: 'user', timestamp: T(13), message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '51' }] } }),
  line({ type: 'assistant', timestamp: T(14), isSidechain: true, message: { content: [{ type: 'text', text: 'subagent chatter' }] } }),
  line({ type: 'assistant', timestamp: T(15), message: { content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/p/a.ts', old_string: 'a', new_string: 'b' } }] } }),
  line({ type: 'user', timestamp: T(16), message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: [{ type: 'text', text: 'not found' }] }] } }),
  'not json',
  line({ type: 'assistant', timestamp: T(17), message: { content: [{ type: 'text', text: '51.' }] } }),
].join('\n');
const since = Date.parse(T(9));

describe('agent turn', () => {
  it('keeps only this turn, skips thinking and subagents', () => {
    const ev = parseTurn(JSONL, since);
    expect(ev.map((e) => e.kind)).toEqual(['text', 'tool', 'result', 'tool', 'result', 'text']);
    expect(JSON.stringify(ev)).not.toContain('old turn');
    expect(JSON.stringify(ev)).not.toContain('subagent');
  });

  it('summarizes tools, edits and errors', () => {
    const s = summarize(parseTurn(JSONL, since), 0, 42_000);
    expect(s).toMatchObject({ durationMs: 42_000, toolCount: 2, tools: { Bash: 1, Edit: 1 }, filesEdited: ['/p/a.ts'], errors: 1, textBlocks: 2 });
  });

  it('outline: every text, one line per tool, errors marked', () => {
    const o = renderOutline(parseTurn(JSONL, since));
    expect(o).toContain('Checking.');
    expect(o).toContain('→ Bash: python3 -c "print(17*3)"');
    expect(o).toContain('→ Edit: /p/a.ts  (error)');
    expect(o.trim().endsWith('51.')).toBe(true);
    expect(o).not.toContain('⤷');
  });

  it('full: tool results, clipped', () => {
    const f = renderFull(parseTurn(JSONL, since), 5);
    expect(f).toContain('⤷ result\n51');
    expect(f).toContain('✗ error\nnot f');
    expect(f).toContain('more chars');
  });
});
