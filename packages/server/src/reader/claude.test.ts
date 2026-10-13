import { describe, expect, it } from 'vitest';
import type { ReaderUpdate } from '@ttym/protocol';
import { parseClaudeLines } from './claude.js';

const T = (s: number) => new Date(Date.UTC(2026, 9, 13, 0, 0, s)).toISOString();
const line = (o: unknown) => JSON.stringify(o);
const parse = (...records: unknown[]) => parseClaudeLines(records.map(line));
const only = <O extends ReaderUpdate['op']>(updates: ReaderUpdate[], op: O) => updates.filter((u): u is Extract<ReaderUpdate, { op: O }> => u.op === op);

describe('claude transcript → reader updates', () => {
  describe('user records', () => {
    it('keeps typed text, whether the content is a string or an array of blocks', () => {
      const u = parse(
        { type: 'user', uuid: 'u1', timestamp: T(1), message: { content: 'first' } },
        { type: 'user', uuid: 'u2', timestamp: T(2), message: { content: [{ type: 'text', text: 'second' }, { type: 'image', source: {} }] } },
      );
      expect(u).toEqual([
        { op: 'user', id: 'u1:0', at: Date.parse(T(1)), text: 'first' },
        { op: 'user', id: 'u2:0', at: Date.parse(T(2)), text: 'second', images: 1 },
      ]);
    });

    it('shows a slash command as the person typed it, and hides the rest of the harness wrappers', () => {
      const u = parse(
        { type: 'user', timestamp: T(1), message: { content: '<command-message>sessionhub</command-message>\n<command-name>/sessionhub</command-name>\n<command-args>claude css</command-args>' } },
        { type: 'user', timestamp: T(2), message: { content: '<local-command-caveat>Caveat: …</local-command-caveat>' } },
        { type: 'user', timestamp: T(3), message: { content: '<local-command-stdout></local-command-stdout>' } },
        { type: 'user', timestamp: T(4), message: { content: '<system-reminder>\nThe date has changed.</system-reminder>' } },
      );
      expect(u.map((x) => x.op === 'user' && x.text)).toEqual(['/sessionhub claude css']);
      expect(u).toHaveLength(1);
    });

    it('turns a background task report into a notice and an interruption into a notice', () => {
      const u = parse(
        { type: 'user', timestamp: T(1), message: { content: '<task-notification>\n<task-id>x</task-id>\n<summary>Monitor event: "page done"</summary>\n</task-notification>' } },
        { type: 'user', timestamp: T(2), message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
      );
      expect(only(u, 'notice').map((n) => n.text)).toEqual(['Monitor event: "page done"', 'Request interrupted by user']);
    });

    it('drops harness-injected text (isMeta) and subagent records', () => {
      const u = parse(
        { type: 'user', timestamp: T(1), isMeta: true, message: { content: 'Base directory for this skill: /x' } },
        { type: 'user', timestamp: T(2), isSidechain: true, message: { content: 'subagent prompt' } },
        { type: 'assistant', timestamp: T(3), isSidechain: true, message: { content: [{ type: 'text', text: 'subagent says' }] } },
      );
      expect(u).toEqual([]);
    });
  });

  describe('assistant records', () => {
    it('emits text and tool calls, and skips thinking that holds nothing but a signature', () => {
      const u = parse(
        { type: 'assistant', uuid: 'a1', timestamp: T(1), message: { content: [{ type: 'thinking', thinking: '', signature: 'sig' }] } },
        { type: 'assistant', uuid: 'a2', timestamp: T(2), message: { content: [{ type: 'text', text: 'Reading it.' }] } },
        { type: 'assistant', uuid: 'a3', timestamp: T(3), message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la', description: 'list' } }] } },
      );
      expect(u.map((x) => x.op)).toEqual(['text', 'tool']);
      expect(u[1]).toMatchObject({ op: 'tool', id: 't1', name: 'Bash', target: 'ls -la', input: 'ls -la' });
    });

    it('keeps thinking that has content', () => {
      const u = parse({ type: 'assistant', timestamp: T(1), message: { content: [{ type: 'thinking', thinking: 'consider the edge case' }] } });
      expect(u).toMatchObject([{ op: 'thinking', text: 'consider the edge case' }]);
    });

    it('labels a call by the most telling input and expands the rest as JSON', () => {
      const u = parse({ type: 'assistant', timestamp: T(1), message: { content: [{ type: 'tool_use', id: 't', name: 'Grep', input: { pattern: 'format_cmd_json', path: 'holder' } }] } });
      const tool = only(u, 'tool')[0];
      expect(tool.target).toBe('format_cmd_json');
      expect(JSON.parse(tool.input)).toEqual({ pattern: 'format_cmd_json', path: 'holder' });
    });
  });

  describe('edits', () => {
    it('builds a patch from the call itself, before the tool has run', () => {
      const u = parse({ type: 'assistant', timestamp: T(1), message: { content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/p/a.rs', old_string: 'a\nb', new_string: 'c' } }] } });
      const tool = only(u, 'tool')[0];
      expect(tool.input).toBe('');
      expect(tool.patch).toEqual({ file: '/p/a.rs', hunks: [{ header: '', lines: [{ op: '-', text: 'a' }, { op: '-', text: 'b' }, { op: '+', text: 'c' }] }] });
    });

    it('shows a Write as an all-added file and caps very long patches', () => {
      const content = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n');
      const u = parse({ type: 'assistant', timestamp: T(1), message: { content: [{ type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: '/p/new.md', content } }] } });
      const patch = only(u, 'tool')[0].patch!;
      expect(patch.truncated).toBe(true);
      expect(patch.hunks[0].lines).toHaveLength(400);
      expect(patch.hunks[0].lines.every((l) => l.op === '+')).toBe(true);
    });

    it('does not count the newline that ends a file as another line', () => {
      const u = parse({ type: 'assistant', timestamp: T(1), message: { content: [{ type: 'tool_use', id: 'w2', name: 'Write', input: { file_path: '/p/a.md', content: 'one\ntwo\n' } }] } });
      expect(only(u, 'tool')[0].patch!.hunks[0].lines.map((l) => l.text)).toEqual(['one', 'two']);
    });

    it("prefers Claude Code's own structuredPatch once the tool finishes", () => {
      const u = parse({
        type: 'user', timestamp: T(2), message: { content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'The file has been updated.' }] },
        toolUseResult: { filePath: '/p/a.rs', structuredPatch: [{ oldStart: 23, oldLines: 2, newStart: 23, newLines: 2, lines: [' ctx', '-old', '+new'] }] },
      });
      expect(u).toEqual([{
        op: 'tool-result', id: 'e1', at: Date.parse(T(2)), output: 'The file has been updated.', isError: false,
        patch: { file: '/p/a.rs', hunks: [{ header: '@@ -23,2 +23,2 @@', lines: [{ op: ' ', text: 'ctx' }, { op: '-', text: 'old' }, { op: '+', text: 'new' }] }] },
      }]);
    });

    it('ignores an empty structuredPatch (a created file reports []).', () => {
      const u = parse({ type: 'user', timestamp: T(2), message: { content: [{ type: 'tool_result', tool_use_id: 'w1', content: 'created' }] }, toolUseResult: { type: 'create', filePath: '/p/new.md', structuredPatch: [] } });
      expect(only(u, 'tool-result')[0].patch).toBeUndefined();
    });
  });

  describe('tool results', () => {
    it('reads string and block content, marks errors, and cuts huge output', () => {
      const big = 'x'.repeat(20_000);
      const u = parse({
        type: 'user', timestamp: T(1), message: { content: [
          { type: 'tool_result', tool_use_id: 'a', content: 'ok' },
          { type: 'tool_result', tool_use_id: 'b', is_error: true, content: [{ type: 'text', text: 'boom' }, { type: 'image', source: {} }] },
          { type: 'tool_result', tool_use_id: 'c', content: big },
        ] },
      });
      const r = only(u, 'tool-result');
      expect(r.map((x) => [x.id, x.isError])).toEqual([['a', false], ['b', true], ['c', false]]);
      expect(r[1].output).toBe('boom\n[image]');
      expect(r[2].truncated).toBe(true);
      expect(r[2].output).toHaveLength(12_000);
    });

    it('does not treat a tool result as something the person said', () => {
      const u = parse({ type: 'user', timestamp: T(1), message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] } });
      expect(u.map((x) => x.op)).toEqual(['tool-result']);
    });
  });

  describe('turn bookkeeping', () => {
    it('reads turn duration and compaction', () => {
      const u = parse(
        { type: 'system', subtype: 'turn_duration', uuid: 'd1', timestamp: T(5), durationMs: 39057, messageCount: 42 },
        { type: 'system', subtype: 'compact_boundary', uuid: 'c1', timestamp: T(6), compactMetadata: { trigger: 'auto', preTokens: 642243, postTokens: 29948 } },
        { type: 'system', subtype: 'compact_boundary', uuid: 'c2', timestamp: T(7) },
        { type: 'system', subtype: 'stop_hook_summary', timestamp: T(8) },
        { type: 'system', subtype: 'local_command', timestamp: T(9) },
      );
      expect(u).toMatchObject([
        { op: 'turn-end', durationMs: 39057 },
        { op: 'boundary', label: 'Conversation compacted · 642k → 30k tokens' },
        { op: 'boundary', label: 'Conversation compacted' },
      ]);
    });

    it('reads the queue, marking what the agent queued for itself', () => {
      const u = parse(
        { type: 'queue-operation', operation: 'enqueue', timestamp: T(1), content: 'also fix the README' },
        { type: 'queue-operation', operation: 'enqueue', timestamp: T(2), content: '<task-notification>\n<task-id>x</task-id>' },
        { type: 'queue-operation', operation: 'dequeue', timestamp: T(3) },
        { type: 'queue-operation', operation: 'remove', timestamp: T(4) },
      );
      expect(u).toMatchObject([
        { op: 'queue', action: 'enqueue', text: 'also fix the README', system: false },
        { op: 'queue', action: 'enqueue', system: true },
        { op: 'queue', action: 'dequeue' },
      ]);
    });

    it('reads the generated title', () => {
      expect(parse({ type: 'ai-title', aiTitle: 'gpai-monorepo PR #1245' })).toEqual([{ op: 'title', text: 'gpai-monorepo PR #1245' }]);
    });
  });

  it('skips lines that are not JSON and record types it does not know', () => {
    const u = parseClaudeLines(['not json', '', line({ type: 'file-history-snapshot' }), line({ type: 'attachment' }), '[1,2]', line({ type: 'ai-title', aiTitle: 't' })]);
    expect(u).toEqual([{ op: 'title', text: 't' }]);
  });
});
