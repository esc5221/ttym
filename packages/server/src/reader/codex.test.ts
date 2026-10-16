import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codexSource, findCodexIn, parseApplyPatch, parseCodexLines } from './codex.js';
import { readerFeed } from './index.js';

const T = (s: number) => new Date(Date.UTC(2026, 9, 13, 0, 0, s)).toISOString();
const wrap = (type: string, payload: unknown, s: number) => JSON.stringify({ timestamp: T(s), type, payload });
const ev = (payload: unknown, s: number) => wrap('event_msg', payload, s);
const item = (payload: unknown, s: number) => wrap('response_item', payload, s);
const shown = (lines: string[]) => parseCodexLines(lines);

describe('codex · events up to 0.144', () => {
  const lines = [
    wrap('session_meta', { id: 'x', cwd: '/w' }, 0),
    ev({ type: 'task_started', turn_id: 't1' }, 1),
    ev({ type: 'user_message', message: '  fix the bug  ', images: [{}], local_images: [] }, 2),
    item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the bug' }] }, 2),
    ev({ type: 'agent_reasoning', text: '**Looking at it**' }, 3),
    item({ type: 'reasoning', id: 'rs1', summary: [{ type: 'summary_text', text: '**Looking at it**' }] }, 3),
    ev({ type: 'agent_message', message: 'I will read the file.', phase: 'commentary' }, 4),
    item({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I will read the file.' }] }, 4),
    item({ type: 'function_call', name: 'shell', call_id: 'c1', arguments: JSON.stringify({ command: ['bash', '-lc', 'cat a.txt && ls'], workdir: '/w' }) }, 5),
    item({ type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ output: 'hello\n', metadata: { exit_code: 0, duration_seconds: 0.1 } }) }, 6),
    item({ type: 'function_call', name: 'shell', call_id: 'c2', arguments: JSON.stringify({ command: ['ls', 'nope'] }) }, 7),
    item({ type: 'function_call_output', call_id: 'c2', output: JSON.stringify({ output: 'ls: nope: No such file', metadata: { exit_code: 1 } }) }, 8),
    ev({ type: 'task_complete', turn_id: 't1', last_agent_message: 'done', duration_ms: 7000 }, 9),
  ];

  it('reads each thing once: the words from events, not from the response items that repeat them', () => {
    const ups = shown(lines);
    expect(ups.filter((u) => u.op === 'user')).toHaveLength(1);
    expect(ups.filter((u) => u.op === 'text')).toHaveLength(1);
    expect(ups.filter((u) => u.op === 'thinking')).toHaveLength(1);
    expect(ups.find((u) => u.op === 'user')).toMatchObject({ text: 'fix the bug', images: 1 });
  });

  it('shows a shell call as Bash with the script that ran, and takes failure from the exit code', () => {
    const ups = shown(lines);
    const tools = ups.filter((u) => u.op === 'tool');
    expect(tools[0]).toMatchObject({ id: 'c1', name: 'Bash', target: 'cat a.txt && ls' });
    const results = ups.filter((u) => u.op === 'tool-result');
    expect(results[0]).toMatchObject({ id: 'c1', output: 'hello\n', isError: false });
    expect(results[1]).toMatchObject({ id: 'c2', isError: true });
  });

  it('ends the turn with the duration Codex measured', () => {
    expect(shown(lines).at(-1)).toMatchObject({ op: 'turn-end', durationMs: 7000 });
  });
});

describe('codex · items from 0.147', () => {
  const patch = ['*** Begin Patch', '*** Update File: src/a.ts', '@@ function f()', ' keep', '-old', '+new', '*** End Patch'].join('\n');
  const lines = [
    ev({ type: 'item_completed', item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'refactor it' }] } }, 1),
    ev({ type: 'item_completed', item: { type: 'Reasoning', id: 'r1', summary_text: ['**Plan**'], raw_content: [] } }, 2),
    ev({ type: 'item_completed', item: { type: 'AgentMessage', id: 'm1', content: [{ type: 'Text', text: 'Reading first.' }] } }, 3),
    item({ type: 'custom_tool_call', name: 'exec', call_id: 'e1', input: 'const r = await tools.exec_command({cmd:"rg -n foo src",\"workdir\":\"/w\"});text(r.output)\n' }, 4),
    item({ type: 'custom_tool_call_output', call_id: 'e1', output: [{ type: 'input_text', text: 'Script completed\nWall time 0.2 seconds\nOutput:\n' }, { type: 'input_text', text: 'src/a.ts:1: foo' }] }, 5),
    item({ type: 'custom_tool_call', name: 'apply_patch', call_id: 'p1', input: patch }, 6),
    item({ type: 'custom_tool_call_output', call_id: 'p1', output: 'Success. Updated the following files:\nM src/a.ts\n' }, 7),
    item({ type: 'custom_tool_call', name: 'exec', call_id: 'e2', input: 'text(await tools.exec_command({cmd:"false"}))' }, 8),
    item({ type: 'custom_tool_call_output', call_id: 'e2', output: 'Script failed\nWall time 1 seconds\nOutput:\nboom' }, 9),
    ev({ type: 'turn_aborted', turn_id: 't1', reason: 'interrupted', duration_ms: 5 }, 10),
  ];

  it('reads user, reasoning and agent text from the items', () => {
    const ups = shown(lines);
    expect(ups.filter((u) => u.op === 'user' || u.op === 'thinking' || u.op === 'text').map((u) => [u.op, (u as { text: string }).text]))
      .toEqual([['user', 'refactor it'], ['thinking', '**Plan**'], ['text', 'Reading first.']]);
  });

  it('shows code mode as the commands in it, and drops its "Script completed" header', () => {
    const ups = shown(lines);
    expect(ups.find((u) => u.op === 'tool' && u.id === 'e1')).toMatchObject({ name: 'Bash', target: 'rg -n foo src' });
    expect(ups.find((u) => u.op === 'tool-result' && u.id === 'e1')).toMatchObject({ output: 'src/a.ts:1: foo', isError: false });
    expect(ups.find((u) => u.op === 'tool-result' && u.id === 'e2')).toMatchObject({ output: 'boom', isError: true });
  });

  it('turns apply_patch into an edit with its diff', () => {
    const t = shown(lines).find((u) => u.op === 'tool' && u.id === 'p1');
    expect(t).toMatchObject({ name: 'Edit', target: 'src/a.ts', patch: { file: 'src/a.ts', hunks: [{ header: '@@ function f()', lines: [{ op: ' ', text: 'keep' }, { op: '-', text: 'old' }, { op: '+', text: 'new' }] }] } });
  });

  it('marks a command that was aborted by the person as failed', () => {
    const ups = shown([item({ type: 'function_call', name: 'shell', call_id: 'a', arguments: '{"command":["sleep","9"]}' }, 1), item({ type: 'function_call_output', call_id: 'a', output: 'aborted by user after 29.5s' }, 2)]);
    expect(ups[1]).toMatchObject({ isError: true });
  });

  it('marks an interrupted turn', () => {
    expect(shown(lines).at(-1)).toMatchObject({ op: 'notice', text: 'Interrupted', endsTurn: true });
  });
});

describe('codex · the first versions', () => {
  it('reads bare response items, which are all those logs have', () => {
    const ups = shown([
      JSON.stringify({ id: 'abc', timestamp: T(0), instructions: null }),
      JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n cwd </environment_context>' }] }),
      JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list files' }] }),
      JSON.stringify({ type: 'reasoning', id: 'r', summary: [{ type: 'summary_text', text: '**Listing**' }] }),
      JSON.stringify({ type: 'function_call', name: 'shell', call_id: 'c', arguments: '{"command":["ls"]}' }),
      JSON.stringify({ type: 'function_call_output', call_id: 'c', output: '{"output":"a\\nb","metadata":{"exit_code":0}}' }),
      JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'two files' }] }),
    ]);
    expect(ups.map((u) => u.op)).toEqual(['user', 'thinking', 'tool', 'tool-result', 'text']);
    expect(ups[0]).toMatchObject({ text: 'list files' });
  });
});

describe('codex · ids', () => {
  it('numbers a message said twice in a log without timestamps, so both are shown', () => {
    const say = JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] });
    const ids = shown([say, say]).map((u) => (u as { id: string }).id);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('codex · other tools', () => {
  it('shows web searches, tool searches and the plan', () => {
    const ups = shown([
      item({ type: 'web_search_call', id: 'ws1', status: 'completed', action: { type: 'search', query: 'q1', queries: ['q1', 'q2'] } }, 1),
      item({ type: 'tool_search_call', call_id: 'ts1', arguments: { query: 'code search' } }, 2),
      item({ type: 'tool_search_output', call_id: 'ts1', tools: [{ type: 'namespace', name: 'mcp__x', tools: [{ name: 'a' }, { name: 'b' }] }] }, 3),
      item({ type: 'function_call', name: 'update_plan', call_id: 'pl', arguments: JSON.stringify({ plan: [{ step: 'one', status: 'completed' }, { step: 'two', status: 'in_progress' }] }) }, 4),
    ]);
    expect(ups.find((u) => u.op === 'tool' && u.name === 'WebSearch')).toMatchObject({ target: 'q1' });
    expect(ups.find((u) => u.op === 'tool-result' && u.id === 'ts1')).toMatchObject({ output: '2 tools: a, b' });
    expect(ups.find((u) => u.op === 'tool' && u.name === 'Plan')).toMatchObject({ input: '[x] one\n[~] two' });
  });

  it('does not show an encrypted agent-to-agent message as its target', () => {
    const ups = shown([item({ type: 'function_call', name: 'send_input', call_id: 'k', arguments: JSON.stringify({ message: `gAAAAAB${'x'.repeat(60)}`, task_name: 'review' }) }, 1)]);
    expect(ups[0]).toMatchObject({ target: 'review' });
  });
});

describe('parseApplyPatch', () => {
  it('reads several files into one patch, hunks headed by their file', () => {
    const r = parseApplyPatch(['*** Begin Patch', '*** Add File: n.txt', '+hi', '*** Delete File: o.txt', '*** Update File: m.ts', '@@', '-a', '+b', '*** End Patch'].join('\n'));
    expect(r?.files).toEqual(['n.txt', 'o.txt', 'm.ts']);
    expect(r?.patch.file).toBe('3 files');
    expect(r?.patch.hunks.map((h) => h.header)).toEqual(['n.txt (new file)', 'o.txt (deleted)', 'm.ts']);
  });
  it('is null for text that is not a patch', () => { expect(parseApplyPatch('hello')).toBeNull(); });
});

describe('codex · finding the rollout', () => {
  let home: string;
  const realCodexHome = process.env.CODEX_HOME;
  // A UUIDv7 whose first 48 bits are 2026-10-13 00:00:00 UTC
  const sid = `${Math.floor(Date.UTC(2026, 9, 13) ).toString(16).padStart(12, '0').replace(/^(.{8})(.{4})$/, '$1-$2')}-7abc-8def-9012-345678901234`;
  beforeAll(() => { home = mkdtempSync(join(tmpdir(), 'ttym-codex-')); process.env.CODEX_HOME = home; });
  afterAll(() => { if (realCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = realCodexHome; rmSync(home, { recursive: true, force: true }); });

  it('finds it by the day the id was made, and reads it as a Codex session', async () => {
    const dir = join(home, 'sessions', '2026', '10', '13');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `rollout-2026-10-13T09-00-00-${sid}.jsonl`), `${ev({ type: 'user_message', message: 'hello', images: [] }, 1)}\n`);
    const found = await codexSource.locate({ codexSessionId: sid }, {});
    expect(found?.key).toBe(sid);
    const feed = await readerFeed({ codexSessionId: sid }, { after: null, key: null });
    expect(feed).toMatchObject({ agent: 'codex', supported: true, key: sid });
    expect(feed.updates).toMatchObject([{ op: 'user', text: 'hello' }]);
  });

  it('looks everywhere when the file is not under the day the id says', async () => {
    const other = '01234567-89ab-7cde-8f01-23456789abcd';
    const dir = join(home, 'sessions', '2030', '01', '01');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `rollout-2030-01-01T00-00-00-${other}.jsonl`), '\n');
    expect((await codexSource.locate({ codexLastSessionId: other }, {}))?.key).toBe(other);
  });

  it('has nothing for a session that never linked to Codex', async () => {
    expect(await codexSource.locate({}, {})).toBeNull();
  });
});

describe('findCodexIn', () => {
  const proc = (pid: number, ppid: number, command: string) => ({ pid, ppid, command, rss: 0 });
  const find = (cmd: string) => findCodexIn([proc(10, 1, '/bin/zsh'), proc(11, 10, cmd)], 10)?.pid ?? null;

  it('finds the interactive codex under the shell, with or without flags and with resume', () => {
    expect(find('codex')).toBe(11);
    expect(find('codex --dangerously-bypass-approvals-and-sandbox resume')).toBe(11);
    expect(find('/opt/homebrew/Caskroom/codex/0.162.1/bin/codex resume 01a1')).toBe(11);
  });

  it('skips exec and the other subcommands, and processes that only share the name prefix', () => {
    expect(find('codex exec --json hi')).toBeNull();
    expect(find('codex app-server --listen unix://')).toBeNull();
    expect(find('codex login')).toBeNull();
    expect(find('/x/bin/codex-code-mode-host')).toBeNull();
  });

  it('finds it a few levels down, and not under another pane', () => {
    const procs = [proc(10, 1, '/bin/zsh'), proc(11, 10, 'node wrapper'), proc(12, 11, 'codex'), proc(20, 1, '/bin/zsh'), proc(21, 20, 'ls')];
    expect(findCodexIn(procs, 10)?.pid).toBe(12);
    expect(findCodexIn(procs, 20)).toBeNull();
  });
});
