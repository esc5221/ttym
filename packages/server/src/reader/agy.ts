import { execFile } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { ReaderPatch, ReaderPatchLine, ReaderUpdate } from '@ttym/protocol';
import { psProcesses, type ProcInfo } from '../agent-sleep.js';
import { all, decode, first, msg, num, text, type Message } from './agy-wire.js';
import * as F from './agy-fields.js';
import type { CursorSource, LocatedRecord } from './source.js';

/**
 * Antigravity CLI (`agy`), read as a conversation.
 *
 * Each conversation is a SQLite file, ~/.gemini/antigravity-cli/conversations/<uuid>.db, with one row per step in
 * `steps(idx, step_type, status, step_payload)`. The payload is a protobuf `gemini_coder.Step`; its field numbers
 * are in agy-fields.ts (generated from the binary by scripts/agy-fields.py) and agy-wire.ts reads the bytes.
 *
 * Across 80 recent conversations only six kinds of step occur, which is all this reads:
 *   USER_INPUT        what the person typed
 *   PLANNER_RESPONSE  the model's turn: its thinking, its words, and the tool calls it made
 *   GENERIC           one tool call with its result in the same row (view_file, run_command, replace_file_content …)
 *   SYSTEM_MESSAGE    a finished background task and the like
 *   ERROR_MESSAGE     a failed request (quota, network)
 *   CHECKPOINT        a summary written when the context was compacted
 *
 * The record is a table, not a file that only grows: a step is written when it starts and rewritten as it
 * progresses (status), so the cursor is a step number, and steps that are not finished are sent again until they are.
 *
 * agy leaves nothing in the pane's meta (no hook), so the conversation is found through the process: agy holds
 * presence/<conversation>.lock open for as long as it is working on that conversation.
 */

const MAX_OUTPUT = 12_000;
const MAX_INPUT = 4_000;
const MAX_TARGET = 200;
const MAX_SUMMARY = 40_000;
const MAX_PATCH_LINES = 400;
/** Steps in the first answer, and in each page of earlier history. */
const PAGE_STEPS = 300;
/** The most steps one ask re-reads because an earlier step was still going. */
const RESEND_STEPS = 200;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

// ───── steps → updates ─────

export interface StepRow {
  idx: number;
  type: number;
  status: number;
  payload: Uint8Array;
}

/** A step whose status will not change any more. Everything else is read again next time. */
const FINAL = new Set<number>([F.STATUS.done, F.STATUS.error, F.STATUS.canceled, F.STATUS.interrupted, F.STATUS.cleared, F.STATUS.invalid]);
export const isFinalStatus = (status: number): boolean => FINAL.has(status);

function stampMs(ts: Message | undefined): number {
  if (!ts) return 0;
  return num(first(ts, F.TIMESTAMP.seconds)) * 1000 + Math.round(num(first(ts, F.TIMESTAMP.nanos)) / 1e6);
}

/**
 * `turnStart`: when the turn that the first row belongs to began, when it began before the rows given (the answer
 * to an incremental ask holds only the steps since the last one). 0 when the first row begins it.
 */
export function parseAgySteps(rows: StepRow[], turnStart0 = 0): ReaderUpdate[] {
  const out: ReaderUpdate[] = [];
  /** When the turn in progress began: its first step, or the message that started it. */
  let turnStart = turnStart0;
  for (const row of rows) {
    const step = decode(row.payload);
    const meta = msg(first(step, F.STEP.metadata));
    const created = stampMs(msg(first(meta, F.META.createdAt)));
    const completed = stampMs(msg(first(meta, F.META.completedAt))) || created;
    const id = `agy:${row.idx}`;
    const done = row.status === F.STATUS.done;

    if (row.status === F.STATUS.interrupted) {
      out.push({ op: 'notice', id: `${id}:int`, at: completed, text: 'Interrupted', endsTurn: true });
      turnStart = 0;
    }

    switch (row.type) {
      case F.STEP_TYPE.userInput: {
        if (!done) break;
        const input = msg(first(step, F.STEP.userInput));
        const said = text(first(input, F.USER_INPUT.userResponse)).trim()
          || all(input, F.USER_INPUT.items).map((i) => text(first(msg(i), F.TEXT_ITEM.text))).join('\n').trim();
        if (said) out.push({ op: 'user', id, at: created, text: said });
        turnStart = created;
        break;
      }
      case F.STEP_TYPE.plannerResponse: {
        if (!done) break;
        if (!turnStart) turnStart = created;
        const p = msg(first(step, F.STEP.plannerResponse));
        const thinking = text(first(p, F.PLANNER.thinking)).trim();
        const said = (text(first(p, F.PLANNER.modifiedResponse)) || text(first(p, F.PLANNER.response))).trim();
        if (thinking) out.push({ op: 'thinking', id: `${id}:think`, at: created, text: thinking });
        if (said) out.push({ op: 'text', id: `${id}:text`, at: completed, text: said });
        // A response that calls no tool is the end of the turn; the tool steps that follow it belong to the next response.
        if (all(p, F.PLANNER.toolCalls).length === 0) {
          out.push({ op: 'turn-end', id: `${id}:end`, at: completed, durationMs: Math.max(0, completed - turnStart) });
          turnStart = 0;
        }
        break;
      }
      case F.STEP_TYPE.generic:
        if (!turnStart) turnStart = created;
        pushTool(out, row, step, meta, id, created, completed);
        break;
      case F.STEP_TYPE.systemMessage: {
        if (!done) break;
        const sm = msg(first(step, F.STEP.systemMessage));
        if (num(first(msg(first(sm, F.SYSTEM_MESSAGE.agentMessage)), F.AGENT_MESSAGE.hideFromUser))) break;
        const title = text(first(msg(first(sm, F.SYSTEM_MESSAGE.renderInfo)), F.RENDER_INFO.title)).trim();
        const body = oneLine(text(first(sm, F.SYSTEM_MESSAGE.message)));
        const shown = title || body;
        if (shown) out.push({ op: 'notice', id, at: created, text: clip(shown, MAX_TARGET) });
        break;
      }
      case F.STEP_TYPE.errorMessage: {
        const e = msg(first(msg(first(step, F.STEP.errorMessage)), F.ERROR_MESSAGE.error));
        const shown = text(first(e, F.ERROR.userErrorMessage)).trim() || text(first(e, F.ERROR.shortError)).trim();
        if (shown) out.push({ op: 'notice', id, at: created, text: clip(oneLine(shown), 400), endsTurn: true });
        turnStart = 0;
        break;
      }
      case F.STEP_TYPE.checkpoint: {
        if (!done) break;
        const c = msg(first(step, F.STEP.checkpoint));
        out.push({ op: 'boundary', id, at: created, label: 'Conversation checkpoint' });
        const summary = text(first(c, F.CHECKPOINT.sessionSummary)).trim();
        if (summary) out.push({ op: 'summary', id: `${id}:summary`, at: created, text: clip(summary, MAX_SUMMARY) });
        break;
      }
    }
  }
  return out;
}

// ───── tools ─────

function argsOf(generic: Message | undefined, call: Message | undefined): Record<string, string> {
  const args: Record<string, string> = {};
  for (const a of all(generic, F.GENERIC.args)) {
    const m = msg(a);
    const key = text(first(m, F.ARG.key));
    if (key) args[key] = text(first(m, F.ARG.value));
  }
  if (Object.keys(args).length === 0) {
    try {
      const j = JSON.parse(text(first(call, F.TOOL_CALL.argumentsJson))) as Record<string, unknown>;
      for (const [k, v] of Object.entries(j)) args[k] = typeof v === 'string' ? v : JSON.stringify(v);
    } catch { /* no arguments to show */ }
  }
  return args;
}

interface Shown { name: string; target: string; input: string; patch?: ReaderPatch }

function range(args: Record<string, string>): string {
  const a = args.StartLine, b = args.EndLine;
  return a && b ? `:${a}-${b}` : a ? `:${a}` : '';
}

/** Names as the other agents' tools are shown, so a pane reads the same whichever agent is in it. */
function shownTool(name: string, args: Record<string, string>): Shown {
  const pick = (...keys: string[]): string => oneLine(keys.map((k) => args[k]).find((v) => v && v.trim()) ?? '');
  switch (name) {
    case 'run_command': return { name: 'Bash', target: clip(pick('CommandLine'), MAX_TARGET), input: clip(args.CommandLine ?? '', MAX_INPUT) };
    case 'view_file': return { name: 'Read', target: `${pick('AbsolutePath')}${range(args)}`, input: '' };
    case 'grep_search': return { name: 'Grep', target: clip(`${pick('Query')}${args.SearchPath ? `  in ${args.SearchPath}` : ''}`, MAX_TARGET), input: '' };
    case 'find_by_name': return { name: 'Find', target: clip(`${pick('Pattern')}${args.SearchDirectory ? `  in ${args.SearchDirectory}` : ''}`, MAX_TARGET), input: '' };
    case 'list_dir': return { name: 'List', target: pick('DirectoryPath'), input: '' };
    case 'search_web': return { name: 'WebSearch', target: clip(pick('query'), MAX_TARGET), input: '' };
    case 'read_url_content': return { name: 'WebFetch', target: clip(pick('Url'), MAX_TARGET), input: '' };
    case 'send_message': return { name: 'SendMessage', target: clip(pick('Message'), MAX_TARGET), input: clip(args.Message ?? '', MAX_INPUT) };
    case 'manage_task': return { name: 'Task', target: pick('Action') + (args.TaskId ? ` ${args.TaskId.split('/').pop()}` : ''), input: '' };
    case 'schedule': return { name: 'Schedule', target: clip(pick('Prompt', 'TimerCondition'), MAX_TARGET), input: '' };
    case 'replace_file_content':
    case 'multi_replace_file_content': {
      const patch = replacePatch(args);
      return { name: 'Edit', target: pick('TargetFile'), input: patch ? '' : clip(JSON.stringify(args, null, 2), MAX_INPUT), ...(patch ? { patch } : {}) };
    }
    case 'write_to_file': {
      const content = args.CodeContent ?? '';
      const lines = splitLines(content).map((t) => ({ op: '+' as const, text: t }));
      return { name: 'Write', target: pick('TargetFile'), input: '', patch: capPatch({ file: args.TargetFile ?? '', hunks: [{ header: args.Overwrite === 'true' ? 'overwritten' : 'new file', lines }] }) };
    }
    default: {
      const target = pick('toolSummary', 'toolAction', 'Prompt', 'name', 'description');
      const input = Object.entries(args).filter(([k]) => k !== 'toolAction' && k !== 'toolSummary');
      return { name, target: clip(target, MAX_TARGET), input: input.length ? clip(JSON.stringify(Object.fromEntries(input), null, 2), MAX_INPUT) : '' };
    }
  }
}

const splitLines = (s: string): string[] => {
  const lines = s.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
};

/** replace_file_content: one chunk in the arguments; multi_replace_file_content: a JSON list of them. */
function replacePatch(args: Record<string, string>): ReaderPatch | undefined {
  const chunks: Array<{ target: string; replacement: string; start?: string; end?: string }> = [];
  if (args.ReplacementChunks) {
    try {
      for (const c of JSON.parse(args.ReplacementChunks) as Array<Record<string, unknown>>) {
        chunks.push({ target: String(c.TargetContent ?? ''), replacement: String(c.ReplacementContent ?? ''), start: c.StartLine !== undefined ? String(c.StartLine) : undefined, end: c.EndLine !== undefined ? String(c.EndLine) : undefined });
      }
    } catch { /* fall through to a single chunk */ }
  }
  if (chunks.length === 0 && (args.TargetContent !== undefined || args.ReplacementContent !== undefined)) {
    chunks.push({ target: args.TargetContent ?? '', replacement: args.ReplacementContent ?? '', start: args.StartLine, end: args.EndLine });
  }
  if (chunks.length === 0) return undefined;
  const hunks = chunks.map((c) => {
    const lines: ReaderPatchLine[] = [];
    if (c.target) for (const t of splitLines(c.target)) lines.push({ op: '-', text: t });
    if (c.replacement) for (const t of splitLines(c.replacement)) lines.push({ op: '+', text: t });
    return { header: c.start ? `@@ lines ${c.start}${c.end && c.end !== c.start ? `-${c.end}` : ''} @@` : '', lines };
  });
  return capPatch({ file: args.TargetFile ?? '', hunks });
}

function capPatch(patch: ReaderPatch): ReaderPatch {
  let budget = MAX_PATCH_LINES;
  let truncated = false;
  const hunks = [];
  for (const h of patch.hunks) {
    if (budget <= 0) { truncated = true; break; }
    if (h.lines.length > budget) { hunks.push({ ...h, lines: h.lines.slice(0, budget) }); truncated = true; budget = 0; break; }
    hunks.push(h);
    budget -= h.lines.length;
  }
  return truncated ? { ...patch, hunks, truncated: true } : patch;
}

function pushTool(out: ReaderUpdate[], row: StepRow, step: Message, meta: Message | undefined, id: string, created: number, completed: number): void {
  const generic = msg(first(step, F.STEP.generic));
  const call = msg(first(meta, F.META.toolCall));
  const name = text(first(call, F.TOOL_CALL.name)) || 'tool';
  const shown = shownTool(name, argsOf(generic, call));
  out.push({ op: 'tool', id, at: created, name: shown.name, target: shown.target, input: shown.input, ...(shown.patch ? { patch: shown.patch } : {}) });
  if (!isFinalStatus(row.status)) return;

  let output = text(first(msg(first(generic, F.GENERIC.result)), F.GENERIC_RESULT.result));
  let isError = row.status === F.STATUS.error || row.status === F.STATUS.canceled || row.status === F.STATUS.interrupted;
  if (row.status === F.STATUS.canceled && !output) output = 'Canceled';
  if (/^\s*Encountered error in step execution/.test(output)) isError = true;
  if (shown.name === 'Bash') {
    const m = /^\s*The command exited with code (-?\d+)\.\s*(?:Output:\n)?/.exec(output);
    if (m) {
      if (m[1] === '0') output = output.slice(m[0].length); else isError = true;
    }
  }
  output = output.replace(/\r\n/g, '\n');
  const truncated = output.length > MAX_OUTPUT;
  out.push({ op: 'tool-result', id, at: completed, output: truncated ? output.slice(0, MAX_OUTPUT) : output, isError, ...(truncated ? { truncated: true } : {}) });
}

/** A turn ends with a response that calls no tool; the one after it starts the next. */
const endsTurn = (step: Message): boolean =>
  all(msg(first(step, F.STEP.plannerResponse)), F.PLANNER.toolCalls).length === 0;

/**
 * When the turn in progress at step `idx` began, looking back through the steps before it: at the message that
 * started it, or at the first step after the previous turn's last response.
 */
export function turnStartBefore(rows: StepRow[]): number {
  // `rows` are the steps before the window, newest first.
  let startedAt = 0;
  for (const row of rows) {
    const step = decode(row.payload);
    const created = stampMs(msg(first(msg(first(step, F.STEP.metadata)), F.META.createdAt)));
    if (row.type === F.STEP_TYPE.userInput && row.status === F.STATUS.done) return created;
    if (row.type === F.STEP_TYPE.plannerResponse && row.status === F.STATUS.done && endsTurn(step)) return startedAt;
    if (created) startedAt = created;
  }
  return startedAt;
}

// ───── the database ─────

interface Database {
  prepare(sql: string): { all(...args: unknown[]): Array<Record<string, unknown>>; get(...args: unknown[]): Record<string, unknown> | undefined };
  close(): void;
}

async function openDatabase(path: string): Promise<Database> {
  const { DatabaseSync } = (await import('node:sqlite')) as unknown as { DatabaseSync: new (path: string, options: { readOnly: boolean }) => Database };
  return new DatabaseSync(path, { readOnly: true });
}

const COLUMNS = 'idx, step_type AS type, status, step_payload AS payload';

const toRows = (rows: Array<Record<string, unknown>>): StepRow[] =>
  rows.map((r) => ({ idx: Number(r.idx), type: Number(r.type), status: Number(r.status), payload: r.payload instanceof Uint8Array ? r.payload : new Uint8Array() }));

/** The steps ahead of `idx`, newest first, as many as it takes to find where the turn began. */
function earlier(db: Database, idx: number): StepRow[] {
  if (idx <= 0) return [];
  return toRows(db.prepare(`SELECT ${COLUMNS} FROM steps WHERE idx < ? ORDER BY idx DESC LIMIT 200`).all(idx));
}

export async function readAgy(
  path: string,
  req: { after: number | null; before: number | null },
): Promise<{ next: number; from: number; reset: boolean; updates: ReaderUpdate[] }> {
  const db = await openDatabase(path);
  try {
    const last = Number(db.prepare('SELECT MAX(idx) AS m FROM steps').get()?.m ?? -1);

    if (req.before !== null) {
      const start = Math.max(0, req.before - PAGE_STEPS);
      const rows = toRows(db.prepare(`SELECT ${COLUMNS} FROM steps WHERE idx >= ? AND idx < ? ORDER BY idx`).all(start, req.before));
      return { next: req.before, from: start, reset: false, updates: parseAgySteps(rows, turnStartBefore(earlier(db, start))) };
    }

    const fresh = req.after === null || req.after < 0 || req.after > last + 1;
    const from = fresh ? Math.max(0, last + 1 - PAGE_STEPS) : req.after!;
    const rows = toRows(db.prepare(`SELECT ${COLUMNS} FROM steps WHERE idx >= ? ORDER BY idx`).all(from));
    // A step that is not finished changes under the same number, so the next ask starts at the first one that is
    // not, to see it finish. One that stays open for a very long time (a server left running) would make every
    // ask carry everything after it, so only so many steps back are held for it.
    const open = rows.find((r) => !isFinalStatus(r.status));
    const next = open ? Math.max(open.idx, last + 1 - RESEND_STEPS) : last + 1;
    return { next, from, reset: fresh, updates: parseAgySteps(rows, turnStartBefore(earlier(db, from))) };
  } finally {
    db.close();
  }
}

// ───── where the record is ─────

const PRESENCE = /\/presence\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.lock$/;

/** `ps` is shared by everything that asks within a moment; a polling page asks every second. */
let procsCache: { at: number; procs: Promise<ProcInfo[]> } | undefined;
function processes(): Promise<ProcInfo[]> {
  const now = Date.now();
  if (!procsCache || now - procsCache.at > 2000) procsCache = { at: now, procs: psProcesses() };
  return procsCache.procs;
}

const NOT_A_CONVERSATION = new Set(['update', 'install', 'changelog', 'models', 'plugin', 'plugins', 'mcp', 'agent', 'agents', 'remote-control', 'mic-serve', 'help']);

/** The first process under a pane's shell (shell's children, three levels down) whose argv `accept`s. */
export function findUnder(procs: ProcInfo[], shellPid: number, accept: (argv: string[]) => boolean): ProcInfo | null {
  const byParent = new Map<number, ProcInfo[]>();
  for (const p of procs) { const l = byParent.get(p.ppid) ?? []; l.push(p); byParent.set(p.ppid, l); }
  const queue: Array<{ pid: number; depth: number }> = [{ pid: shellPid, depth: 0 }];
  while (queue.length > 0) {
    const { pid, depth } = queue.shift()!;
    for (const child of byParent.get(pid) ?? []) {
      if (accept(child.command.trim().split(/\s+/))) return child;
      if (depth < 2) queue.push({ pid: child.pid, depth: depth + 1 });
    }
  }
  return null;
}

/** The interactive agy under a pane's shell: not `agy -p` and not one of its subcommands. */
export function findAgyIn(procs: ProcInfo[], shellPid: number): ProcInfo | null {
  return findUnder(procs, shellPid, (tokens) => {
    if ((tokens[0] ?? '').split('/').pop() !== 'agy') return false;
    const rest = tokens.slice(1);
    const first = rest.find((t) => !t.startsWith('-'));
    const printing = rest.some((t) => t === '-p' || t === '--print' || t === '--prompt');
    return !printing && !(first && rest[0] === first && NOT_A_CONVERSATION.has(first));
  });
}

export async function findAgyProcess(shellPid: number): Promise<number | null> {
  return findAgyIn(await processes(), shellPid)?.pid ?? null;
}

/** The processes `ps` shows, shared with whatever else asks within a moment. */
export { processes as listProcesses };

/** pid → the conversation it holds, remembered for a few seconds. `lsof` takes a moment and the page asks every second. */
const holding = new Map<number, { at: number; found: Promise<LocatedRecord | null> }>();

function lockedConversations(pid: number): Promise<string[]> {
  return new Promise((done) => {
    execFile('lsof', ['-p', String(pid), '-Fn'], { maxBuffer: 4 << 20 }, (err, stdout) => {
      if (err && !stdout) { done([]); return; }
      done(stdout.split('\n').filter((l) => l.startsWith('n') && PRESENCE.test(l)).map((l) => l.slice(1)));
    });
  });
}

async function conversationOf(pid: number): Promise<LocatedRecord | null> {
  const locks = await lockedConversations(pid);
  let best: { path: string; key: string; mtime: number } | null = null;
  for (const lock of locks) {
    const key = PRESENCE.exec(lock)![1]!;
    const db = resolve(dirname(lock), '..', 'conversations', `${key}.db`);
    try {
      await access(db);
      const mtime = (await stat(db)).mtimeMs;
      if (!best || mtime > best.mtime) best = { path: db, key, mtime };
    } catch { /* the conversation has no rows yet */ }
  }
  return best ? { path: best.path, key: best.key } : null;
}

async function locateAgy(_meta: Record<string, unknown>, ctx: { pid?: number }): Promise<LocatedRecord | null> {
  if (!ctx.pid) return null;
  const agy = await findAgyProcess(ctx.pid);
  if (!agy) return null;
  const hit = holding.get(agy);
  if (hit && Date.now() - hit.at < 3000) return hit.found;
  const found = conversationOf(agy);
  holding.set(agy, { at: Date.now(), found });
  return found;
}

export const agySource: CursorSource = {
  agent: 'agy',
  locate: locateAgy,
  read: (found, req) => readAgy(found.path, req),
};
