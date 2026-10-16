import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as F from './agy-fields.js';
import { decode, first, text } from './agy-wire.js';
import type { ProcInfo } from '../agent-sleep.js';
import { findAgyIn, parseAgySteps, readAgy, type StepRow } from './agy.js';

// ───── a small protobuf encoder, to write steps the way agy does ─────

type Val = string | number | Uint8Array | Val[] | { [field: number]: Val };
const enc = new TextEncoder();
const varint = (n: number): number[] => {
  const out: number[] = [];
  while (n >= 128) { out.push((n % 128) | 128); n = Math.floor(n / 128); }
  out.push(n);
  return out;
};
const field = (n: number, v: Val): number[] => {
  if (Array.isArray(v)) return v.flatMap((x) => field(n, x));
  if (typeof v === 'number') return [...varint(n * 8), ...varint(v)];
  const bytes = typeof v === 'string' ? enc.encode(v) : v instanceof Uint8Array ? v : message(v);
  return [...varint(n * 8 + 2), ...varint(bytes.length), ...bytes];
};
const message = (m: { [field: number]: Val }): Uint8Array => new Uint8Array(Object.entries(m).flatMap(([n, v]) => field(Number(n), v)));

const T0 = 1_791_000_000;
const stamp = (s: number) => ({ [F.TIMESTAMP.seconds]: T0 + s, [F.TIMESTAMP.nanos]: 500_000_000 });
const meta = (created: number, completed = created, extra: Record<number, Val> = {}) => ({ [F.STEP.metadata]: { [F.META.createdAt]: stamp(created), [F.META.completedAt]: stamp(completed), ...extra } });
const row = (idx: number, type: number, status: number, body: Record<number, Val>): StepRow => ({ idx, type, status, payload: message(body) });

const userInput = (idx: number, say: string, at: number) => row(idx, F.STEP_TYPE.userInput, F.STATUS.done, { ...meta(at), [F.STEP.userInput]: { [F.USER_INPUT.userResponse]: say } });
const planner = (idx: number, at: number, p: { say?: string; think?: string; calls?: number }, status: number = F.STATUS.done) => row(idx, F.STEP_TYPE.plannerResponse, status, {
  ...meta(at, at + 1),
  [F.STEP.plannerResponse]: {
    ...(p.say ? { [F.PLANNER.response]: p.say } : {}),
    ...(p.think ? { [F.PLANNER.thinking]: p.think } : {}),
    ...(p.calls ? { [F.PLANNER.toolCalls]: Array.from({ length: p.calls }, (_, i): Val => ({ 1: `call_${i}`, 2: 'x' })) } : {}),
  } as Val,
});
const tool = (idx: number, at: number, name: string, args: Record<string, string>, result: string | null, status: number = F.STATUS.done) => row(idx, F.STEP_TYPE.generic, status, {
  ...meta(at, at + 1, { [F.META.toolCall]: { [F.TOOL_CALL.id]: `call_${idx}`, [F.TOOL_CALL.name]: name } }),
  [F.STEP.generic]: {
    [F.GENERIC.args]: Object.entries(args).map(([k, v]): Val => ({ [F.ARG.key]: k, [F.ARG.value]: v })),
    ...(result === null ? {} : { [F.GENERIC.result]: { [F.GENERIC_RESULT.result]: result } }),
  } as Val,
});

describe('agy wire reader', () => {
  it('reads strings, numbers and nested messages, and skips what it does not know', () => {
    const m = decode(message({ 1: 'héllo', 2: 300, 3: { 1: 'inner' }, 9: 7 }));
    expect(text(first(m, 1))).toBe('héllo');
    expect(first(m, 2)).toBe(300);
    expect(text(first(decode(first(m, 3) as Uint8Array), 1))).toBe('inner');
  });
  it('gives what it could read from a truncated blob instead of throwing', () => {
    const whole = message({ 1: 'abc', 2: 'defghi' });
    const m = decode(whole.subarray(0, whole.length - 3));
    expect(text(first(m, 1))).toBe('abc');
    expect(m.has(2)).toBe(false);
  });
});

describe('agy steps', () => {
  const conversation = [
    userInput(0, 'list the files', 0),
    planner(1, 1, { think: 'I should look', calls: 1 }),
    tool(2, 2, 'run_command', { CommandLine: 'ls -la', Cwd: '/w', toolAction: 'Listing' }, '\nThe command exited with code 0.\nOutput:\na\nb\n'),
    planner(3, 4, { say: 'Two files: a and b.' }),
  ];

  it('reads the person, the thinking, the tool and the answer, and ends the turn with how long it took', () => {
    const ups = parseAgySteps(conversation);
    expect(ups.map((u) => u.op)).toEqual(['user', 'thinking', 'tool', 'tool-result', 'text', 'turn-end']);
    expect(ups[0]).toMatchObject({ text: 'list the files', at: (T0 + 0) * 1000 + 500 });
    expect(ups[2]).toMatchObject({ name: 'Bash', target: 'ls -la', input: 'ls -la' });
    expect(ups[3]).toMatchObject({ output: 'a\nb\n', isError: false });
    expect(ups.at(-1)).toMatchObject({ op: 'turn-end', durationMs: 5000 });
  });

  it('does not end the turn on a response that calls a tool', () => {
    expect(parseAgySteps([planner(1, 1, { say: 'checking', calls: 2 })]).map((u) => u.op)).toEqual(['text']);
  });

  it('shows a tool that is still running as running, and one that failed as an error', () => {
    const running = parseAgySteps([tool(2, 2, 'run_command', { CommandLine: 'sleep 99' }, null, 2)]);
    expect(running.map((u) => u.op)).toEqual(['tool']);
    const failed = parseAgySteps([tool(3, 2, 'view_file', { AbsolutePath: '/nope' }, 'Encountered error in step execution: no such file', F.STATUS.done)]);
    expect(failed[1]).toMatchObject({ op: 'tool-result', isError: true });
    const exit = parseAgySteps([tool(4, 2, 'run_command', { CommandLine: 'false' }, '\nThe command exited with code 1.\nOutput:\nboom')]);
    expect(exit[1]).toMatchObject({ isError: true, output: expect.stringContaining('exited with code 1') });
  });

  it('turns an edit into the diff it makes', () => {
    const ups = parseAgySteps([tool(5, 2, 'replace_file_content', { TargetFile: '/w/a.js', TargetContent: 'old\n', ReplacementContent: 'new1\nnew2\n', StartLine: '3', EndLine: '3' }, 'The following changes were made')]);
    expect(ups[0]).toMatchObject({ name: 'Edit', target: '/w/a.js', patch: { file: '/w/a.js', hunks: [{ header: '@@ lines 3 @@', lines: [{ op: '-', text: 'old' }, { op: '+', text: 'new1' }, { op: '+', text: 'new2' }] }] } });
  });

  it('shows a written file as all additions', () => {
    const ups = parseAgySteps([tool(6, 2, 'write_to_file', { TargetFile: '/w/n.txt', CodeContent: 'a\nb', Overwrite: 'false' }, 'Created file')]);
    expect(ups[0]).toMatchObject({ name: 'Write', patch: { hunks: [{ header: 'new file', lines: [{ op: '+', text: 'a' }, { op: '+', text: 'b' }] }] } });
  });

  it('shows background-task and error steps as notices, and a quota error as the end of the turn', () => {
    const ups = parseAgySteps([
      row(7, F.STEP_TYPE.systemMessage, F.STATUS.done, { ...meta(1), [F.STEP.systemMessage]: { [F.SYSTEM_MESSAGE.message]: '[Message] long machine text', [F.SYSTEM_MESSAGE.renderInfo]: { [F.RENDER_INFO.title]: 'Run digest.py finished' } } }),
      row(8, F.STEP_TYPE.errorMessage, F.STATUS.done, { ...meta(2), [F.STEP.errorMessage]: { [F.ERROR_MESSAGE.error]: { [F.ERROR.userErrorMessage]: 'Individual quota reached. Resets in 4h.' } } }),
    ]);
    expect(ups).toMatchObject([{ op: 'notice', text: 'Run digest.py finished' }, { op: 'notice', text: 'Individual quota reached. Resets in 4h.', endsTurn: true }]);
  });

  it('waits for a response that is still being written, and does not show half of it', () => {
    expect(parseAgySteps([planner(9, 1, { say: 'partial' }, 8)])).toEqual([]);
  });
});

describe('reading the database', () => {
  let dir: string;
  let path: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ttym-agy-'));
    mkdirSync(dir, { recursive: true });
    path = join(dir, 'c.db');
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, step_payload blob)');
    db.close();
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const write = (rows: StepRow[]) => {
    const db = new DatabaseSync(path);
    const put = db.prepare('INSERT OR REPLACE INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)');
    for (const r of rows) put.run(r.idx, r.type, r.status, r.payload);
    db.close();
  };

  it('takes the end of the conversation first, then only what was added, and sends a step again until it is finished', async () => {
    write([userInput(0, 'go', 0), planner(1, 1, { calls: 1 }), tool(2, 2, 'run_command', { CommandLine: 'make' }, null, 2)]);
    const first = await readAgy(path, { after: null, before: null });
    expect(first).toMatchObject({ reset: true, from: 0, next: 2 });
    expect(first.updates.map((u) => u.op)).toEqual(['user', 'tool']);

    // The command finishes and the model answers: the running step is sent again, now with its result, and the new one with it.
    write([tool(2, 2, 'run_command', { CommandLine: 'make' }, '\nThe command exited with code 0.\nOutput:\nok'), planner(3, 5, { say: 'built' })]);
    const second = await readAgy(path, { after: first.next, before: null });
    expect(second.reset).toBe(false);
    expect(second.updates.map((u) => u.op)).toEqual(['tool', 'tool-result', 'text', 'turn-end']);
    // The turn began at the person's message, which this answer does not hold.
    expect(second.updates.at(-1)).toMatchObject({ durationMs: 6000 });

    const third = await readAgy(path, { after: second.next, before: null });
    expect(third.updates).toEqual([]);
  });

  it('starts over when the client holds an offset past the end, and pages back through earlier steps', async () => {
    const rows: StepRow[] = [];
    for (let i = 4; i < 700; i += 2) rows.push(userInput(i, `m${i}`, i), planner(i + 1, i, { say: `r${i}` }));
    write(rows);
    const fresh = await readAgy(path, { after: 99999, before: null });
    expect(fresh.reset).toBe(true);
    expect(fresh.from).toBeGreaterThan(0);
    const page = await readAgy(path, { after: null, before: fresh.from });
    expect(page.next).toBe(fresh.from);
    expect(page.from).toBeLessThan(fresh.from);
    expect(page.updates.length).toBeGreaterThan(0);
  });
});

describe('finding agy under a pane', () => {
  const proc = (pid: number, ppid: number, command: string): ProcInfo => ({ pid, ppid, rss: 0, command });
  const shell = 100;

  it('finds the interactive agy among the shell\'s descendants', () => {
    expect(findAgyIn([proc(101, shell, 'agy --dangerously-skip-permissions'), proc(5, 1, 'launchd')], shell)?.pid).toBe(101);
    expect(findAgyIn([proc(102, shell, '/bin/sh -c wrapper'), proc(103, 102, '/Users/x/.local/bin/agy')], shell)?.pid).toBe(103);
  });
  it('does not take agy -p, its subcommands, or another pane\'s agy', () => {
    expect(findAgyIn([proc(101, shell, 'agy -p "hello"')], shell)).toBeNull();
    expect(findAgyIn([proc(101, shell, 'agy update')], shell)).toBeNull();
    expect(findAgyIn([proc(101, shell, 'agy --model x models')], shell)?.pid).toBe(101);
    expect(findAgyIn([proc(201, 200, 'agy')], shell)).toBeNull();
  });
});
