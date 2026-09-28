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

import { isTranscriptPath, lastText } from './agent-turn.js';

describe('agent turn — the answer', () => {
  it('last text of this turn; blocks of one message are one answer (claude)', () => {
    const NOW = 1_800_000_000_000;
    const t = (ms: number) => new Date(ms).toISOString();
    const jsonl = [
      JSON.stringify({ type: 'assistant', timestamp: t(NOW - 60_000), message: { content: [{ type: 'text', text: 'OLD ANSWER' }] } }),
      JSON.stringify({ type: 'user', timestamp: t(NOW), message: { content: 'q' } }),
      JSON.stringify({ type: 'assistant', timestamp: t(NOW + 1_000), message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }] } }),
      JSON.stringify({ type: 'assistant', timestamp: t(NOW + 2_000), message: { content: [{ type: 'text', text: 'REAL ANSWER' }, { type: 'text', text: 'SECOND BLOCK' }] } }),
    ].join('\n');
    expect(lastText(parseTurn(jsonl, NOW))).toBe('REAL ANSWER\nSECOND BLOCK');
    expect(lastText(parseTurn(jsonl, NOW + 10_000))).toBeNull();
  });

  it('accepts only agent transcript paths from a hook', () => {
    expect(isTranscriptPath('/Users/x/.claude/projects/-a/1.jsonl')).toBe(true);
    expect(isTranscriptPath('/Users/x/.codex/sessions/2026/09/28/rollout-2026-x-01a0.jsonl')).toBe(true);
    expect(isTranscriptPath('/etc/passwd')).toBe(false);
    expect(isTranscriptPath('/Users/x/.claude/projects/../../secret.jsonl')).toBe(false);
    expect(isTranscriptPath('/Users/x/notes/sessions/data.jsonl')).toBe(false);
    expect(isTranscriptPath('relative/.claude/projects/a.jsonl')).toBe(false);
  });
});

describe('agent turn — codex rollout', () => {
  const ev = (type: string, payload: Record<string, unknown>, s: number) =>
    JSON.stringify({ timestamp: new Date(Date.UTC(2026, 8, 28, 0, 0, s)).toISOString(), type, payload });
  const ROLLOUT = [
    ev('session_meta', { id: 'S' }, 0),
    ev('event_msg', { type: 'task_started', turn_id: 'T1' }, 1),
    ev('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'previous turn' }] }, 2),
    ev('event_msg', { type: 'task_complete', turn_id: 'T1', last_agent_message: 'previous turn' }, 3),
    ev('event_msg', { type: 'task_started', turn_id: 'T2' }, 4),
    ev('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'instructions' }] }, 4),
    ev('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'count files' }] }, 4),
    ev('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I will run ls.' }] }, 5),
    ev('response_item', { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'text(await tools.exec_command({cmd:"ls -1 | wc -l",max_output_tokens:2000}));\n' }, 6),
    ev('response_item', { type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'Script completed\nOutput:\n' }, { type: 'input_text', text: '8\n' }] }, 7),
    ev('response_item', { type: 'custom_tool_call', call_id: 'c2', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: /p/a.py\n@@\n-a\n+b\n*** End Patch' }, 8),
    ev('response_item', { type: 'custom_tool_call_output', call_id: 'c2', output: 'Success. Updated the following files:\nM /p/a.py' }, 9),
    ev('response_item', { type: 'custom_tool_call', call_id: 'c4', name: 'exec', input: 'text(await tools.apply_patch("*** Begin Patch\\n*** Update File: /p/b.py\\n@@\\n-x\\n+y\\n*** End Patch"));\ntext(await tools.exec_command({cmd:"uvx pytest",max_output_tokens:3000}));\n' }, 9),
    ev('response_item', { type: 'custom_tool_call_output', call_id: 'c4', output: 'Script completed' }, 9),
    ev('response_item', { type: 'function_call', call_id: 'c3', name: 'sleep', namespace: 'clock', arguments: '{"duration_ms":10}' }, 10),
    ev('response_item', { type: 'function_call_output', call_id: 'c3', output: 'Sleep completed.' }, 11),
    ev('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '8 entries' }] }, 12),
    ev('event_msg', { type: 'task_complete', turn_id: 'T2', last_agent_message: '8 entries' }, 13),
  ].join('\n');

  it('cuts one turn by turn_id and pairs tools with results', () => {
    const events = parseTurn(ROLLOUT, 0, Infinity, 'T2');
    expect(events.map((e) => e.kind)).toEqual(['text', 'tool', 'result', 'tool', 'result', 'tool', 'result', 'tool', 'result', 'text']);
    expect(lastText(events)).toBe('8 entries');
    expect(JSON.stringify(events)).not.toContain('previous turn');
    expect(JSON.stringify(events)).not.toContain('instructions');
  });

  it('summarizes codex tools: exec command, apply_patch files', () => {
    const events = parseTurn(ROLLOUT, 0, Infinity, 'T2');
    expect(summarize(events)).toMatchObject({ toolCount: 4, tools: { exec: 2, apply_patch: 1, 'clock.sleep': 1 }, filesEdited: ['/p/a.py', '/p/b.py'], errors: 0 });
    const outline = renderOutline(events);
    expect(outline).toContain('→ exec: ls -1 | wc -l');
    expect(outline).toContain('→ apply_patch: /p/a.py');
    expect(renderOutline(parseTurn(ROLLOUT.replace('{cmd:"ls -1 | wc -l"', "{cmd:'ls -1 | wc -l'"), 0, Infinity, 'T2'))).toContain('→ exec: ls -1 | wc -l');
    // exec 한 번 안의 패치와 명령이 둘 다 보인다
    expect(outline).toContain('→ exec: apply_patch b.py ; uvx pytest');
    expect(renderFull(events)).toContain('⤷ result\nScript completed');
  });
});
