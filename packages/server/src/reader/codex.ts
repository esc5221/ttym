import { execFile } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ReaderPatch, ReaderPatchLine, ReaderUpdate } from '@ttym/protocol';
import { isTranscriptPath } from '../agent-turn.js';
import { findUnder, listProcesses } from './agy.js';
import type { ProcInfo } from '../agent-sleep.js';
import type { LineSource, SourceContext } from './source.js';

/**
 * Codex's rollout, read as a conversation.
 *
 * $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<session>.jsonl holds one JSON object per line. The format
 * has changed with the CLI, and old sessions stay on disk, so three generations are read here (35 versions
 * between 0.36 and 0.162 were looked at):
 *
 *   wrapped     {timestamp, type, payload}. What the person and the agent said comes as `event_msg`s —
 *               `user_message`/`agent_message`/`agent_reasoning` up to 0.144, `item_completed` items
 *               (UserMessage/AgentMessage/Reasoning) from 0.147 — and the same words are repeated as
 *               `response_item` messages, so those are not read. Tools are read from `response_item`s only:
 *               the `exec_command_end`/`mcp_tool_call_end`/`patch_apply_end` events and the
 *               `item_completed` tool items repeat them under ids that do not match the calls.
 *   unwrapped   the first versions wrote bare `response_item` payloads with no events at all, so the
 *               `message`/`reasoning` payloads are what there is to read.
 *
 * A compaction is read from the `compacted` record, which every version writes; the `ContextCompaction` item and
 * `context_compacted` event of the newer ones repeat it.
 *
 * Tool names are shown the way the agent's own screen shows them; the shell family is "Bash".
 */

const MAX_OUTPUT = 12_000;
const MAX_INPUT = 4_000;
const MAX_TARGET = 200;
const MAX_PATCH_LINES = 400;

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Records without ids (messages, reasoning) are named by time and content, so the same line always has the same id. */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function parseCodexLines(lines: string[]): ReaderUpdate[] {
  const out: ReaderUpdate[] = [];
  for (const line of lines) {
    let e: unknown;
    try { e = JSON.parse(line); } catch { continue; }
    if (!isObj(e)) continue;
    const wrapped = typeof e.type === 'string' && isObj(e.payload);
    const type = wrapped ? String(e.type) : 'response_item';
    const p = wrapped ? (e.payload as Json) : e;
    const at = Date.parse(str(e.timestamp) ?? '') || 0;
    if (type === 'event_msg') pushEvent(out, p, at);
    else if (type === 'response_item') pushItem(out, p, at, !wrapped);
    else if (type === 'compacted') out.push({ op: 'boundary', id: `compact:${at}`, at, label: 'Conversation compacted' });
  }
  return withDistinctIds(out);
}

/**
 * The first versions wrote no timestamps, so two messages with the same words (a "continue" said twice) get the same
 * id, and the page, which takes a repeated id for a repeated delivery, would show one. Within a parse the later ones are numbered.
 */
function withDistinctIds(updates: ReaderUpdate[]): ReaderUpdate[] {
  const seen = new Map<string, number>();
  return updates.map((u) => {
    if (u.op !== 'user' && u.op !== 'text' && u.op !== 'thinking') return u;
    if (!u.id.includes(':0:')) return u;
    const n = seen.get(u.id) ?? 0;
    seen.set(u.id, n + 1);
    return n === 0 ? u : { ...u, id: `${u.id}#${n}` };
  });
}

// ───── event_msg: what was said ─────

function pushEvent(out: ReaderUpdate[], p: Json, at: number): void {
  switch (p.type) {
    case 'user_message': {
      const images = arr(p.images).length + arr(p.local_images).length;
      pushUser(out, str(p.message) ?? '', images, at);
      break;
    }
    case 'agent_message': pushText(out, str(p.message) ?? '', at); break;
    case 'agent_reasoning': pushThinking(out, str(p.text) ?? '', at); break;
    case 'item_completed': pushCompletedItem(out, p, at); break;
    case 'task_complete':
      out.push({ op: 'turn-end', id: `end:${str(p.turn_id) ?? at}`, at, durationMs: Number(p.duration_ms) || 0 });
      break;
    case 'turn_aborted':
      out.push({ op: 'notice', id: `abort:${str(p.turn_id) ?? at}`, at, text: p.reason === 'interrupted' ? 'Interrupted' : `Turn stopped (${str(p.reason) ?? 'aborted'})`, endsTurn: true });
      break;
    case 'thread_rolled_back': {
      const n = Number(p.num_turns) || 1;
      out.push({ op: 'notice', id: `rollback:${at}`, at, text: `Rolled back ${n} turn${n > 1 ? 's' : ''}` });
      break;
    }
    case 'sub_agent_activity': pushSubAgent(out, str(p.event_id) ?? String(at), str(p.kind), str(p.agent_path), at); break;
  }
}

function pushCompletedItem(out: ReaderUpdate[], p: Json, at: number): void {
  const item = isObj(p.item) ? p.item : undefined;
  if (!item) return;
  switch (item.type) {
    case 'UserMessage': pushUser(out, contentText(item.content), 0, at, str(item.id)); break;
    case 'AgentMessage': pushText(out, contentText(item.content), at, str(item.id)); break;
    case 'Reasoning': {
      const text = [...arr(item.summary_text), ...arr(item.raw_content)].map((x) => (typeof x === 'string' ? x : isObj(x) ? str(x.text) ?? '' : '')).filter(Boolean).join('\n\n');
      pushThinking(out, text, at, str(item.id));
      break;
    }
    case 'SubAgentActivity': pushSubAgent(out, str(item.id) ?? String(at), str(item.kind), str(item.agent_path), at); break;
  }
}

/** The text parts of a message's content, whichever way the version names them (`text`, `Text`, `input_text`, `output_text`). */
function contentText(content: unknown): string {
  return arr(content)
    .map((c) => (isObj(c) && typeof c.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join('\n');
}

function pushUser(out: ReaderUpdate[], raw: string, images: number, at: number, id?: string): void {
  const text = raw.trim();
  // Context the harness injects is wrapped in a tag; what the person typed is plain.
  if (text.startsWith('<') && /^<[a-z_]+>/.test(text)) return;
  if (!text && !images) return;
  out.push({ op: 'user', id: `user:${id ?? `${at}:${hash(text)}`}`, at, text, ...(images ? { images } : {}) });
}

function pushText(out: ReaderUpdate[], raw: string, at: number, id?: string): void {
  if (!raw.trim()) return;
  out.push({ op: 'text', id: `text:${id ?? `${at}:${hash(raw)}`}`, at, text: raw });
}

function pushThinking(out: ReaderUpdate[], raw: string, at: number, id?: string): void {
  if (!raw.trim()) return;
  out.push({ op: 'thinking', id: `think:${id ?? `${at}:${hash(raw)}`}`, at, text: raw });
}

function pushSubAgent(out: ReaderUpdate[], id: string, kind: string | undefined, path: string | undefined, at: number): void {
  const name = path?.split('/').filter(Boolean).pop() ?? 'subagent';
  out.push({ op: 'notice', id: `sub:${id}:${kind ?? ''}`, at, text: `Subagent ${name} ${kind ?? 'activity'}` });
}

// ───── response_item: tools, and (unwrapped logs only) the words ─────

function pushItem(out: ReaderUpdate[], p: Json, at: number, unwrapped: boolean): void {
  switch (p.type) {
    case 'message':
      if (!unwrapped) break;
      if (p.role === 'user') pushUser(out, contentText(p.content), 0, at);
      else if (p.role === 'assistant') pushText(out, contentText(p.content), at, str(p.id));
      break;
    case 'reasoning':
      if (!unwrapped) break;
      pushThinking(out, arr(p.summary).map((s) => (isObj(s) ? str(s.text) ?? '' : '')).filter(Boolean).join('\n\n'), at, str(p.id));
      break;
    case 'function_call': pushFunctionCall(out, p, at); break;
    case 'local_shell_call': pushShellCall(out, p, at); break;
    case 'custom_tool_call': pushCustomCall(out, p, at); break;
    case 'function_call_output':
    case 'custom_tool_call_output':
      out.push(toolResult(p, at));
      break;
    case 'web_search_call': pushWebSearch(out, p, at); break;
    case 'tool_search_call': pushToolSearch(out, p, at); break;
    case 'tool_search_output': pushToolSearchOutput(out, p, at); break;
    case 'image_generation_call': pushImage(out, p, at); break;
  }
}

const SHELL_NAMES = new Set(['shell', 'shell_command', 'exec_command', 'local_shell', 'container.exec', 'unified_exec', 'bash']);

function pushFunctionCall(out: ReaderUpdate[], p: Json, at: number): void {
  const call = str(p.call_id);
  if (!call) return;
  const name = str(p.name) ?? '?';
  const args = parseArgs(p.arguments);

  if (SHELL_NAMES.has(name)) {
    const command = shellCommand(args);
    out.push({ op: 'tool', id: call, at, name: 'Bash', target: clip(oneLine(command), MAX_TARGET), input: clip(command, MAX_INPUT) });
    return;
  }
  if (name === 'apply_patch') {
    pushPatchCall(out, call, at, str(args.input) ?? str(args.patch) ?? '');
    return;
  }
  if (name === 'update_plan') {
    const steps = arr(args.plan).filter(isObj);
    const input = steps.map((s) => `${s.status === 'completed' ? '[x]' : s.status === 'in_progress' ? '[~]' : '[ ]'} ${str(s.step) ?? ''}`).join('\n');
    out.push({ op: 'tool', id: call, at, name: 'Plan', target: clip(oneLine(str(args.explanation) ?? `${steps.length} steps`), MAX_TARGET), input: clip(input, MAX_INPUT) });
    return;
  }
  if (name === 'view_image') {
    out.push({ op: 'tool', id: call, at, name: 'View image', target: str(args.path) ?? '', input: '' });
    return;
  }
  out.push({ op: 'tool', id: call, at, name, target: genericTarget(args), input: genericInput(args) });
}

/** Older versions describe a shell call as {command: ["bash","-lc","<script>"]}; the script is what was run. */
function shellCommand(args: Json): string {
  const c = args.command ?? args.cmd;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const parts = c.map(String);
    if (parts.length >= 3 && /^(?:\S*\/)?(?:ba|z)?sh$/.test(parts[0]!) && /^-\w*c\w*$/.test(parts[1]!)) return parts.slice(2).join(' ');
    return parts.join(' ');
  }
  return '';
}

function pushShellCall(out: ReaderUpdate[], p: Json, at: number): void {
  const call = str(p.call_id) ?? str(p.id);
  if (!call) return;
  const action = isObj(p.action) ? p.action : {};
  const command = shellCommand(action);
  out.push({ op: 'tool', id: call, at, name: 'Bash', target: clip(oneLine(command), MAX_TARGET), input: clip(command, MAX_INPUT) });
}

function parseArgs(raw: unknown): Json {
  if (isObj(raw)) return raw;
  if (typeof raw !== 'string') return {};
  try { const v = JSON.parse(raw); return isObj(v) ? v : {}; } catch { return {}; }
}

function genericTarget(args: Json): string {
  for (const key of ['command', 'cmd', 'query', 'path', 'file_path', 'url', 'prompt', 'task_name', 'target', 'message', 'description']) {
    const v = args[key];
    if (typeof v === 'string' && v.trim() && !looksEncrypted(v)) return clip(oneLine(v), MAX_TARGET);
  }
  return '';
}

/** Some agent-to-agent messages are carried as an opaque token (Fernet), which is not text to read. */
const looksEncrypted = (s: string): boolean => /^gAAAA[\w-]{40,}/.test(s);

function genericInput(args: Json): string {
  if (Object.keys(args).length === 0) return '';
  try { return clip(JSON.stringify(args, (_k, v) => (typeof v === 'string' && looksEncrypted(v) ? '[encrypted]' : v), 2), MAX_INPUT); } catch { return ''; }
}

// ───── custom tools (code mode's `exec`, apply_patch) ─────

const CMD_IN_CODE = /\bcmd\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;

function unquote(lit: string): string {
  if (lit.startsWith('"')) { try { return JSON.parse(lit) as string; } catch { /* fall through to the raw text */ } }
  return lit.slice(1, -1).replace(/\\n/g, '\n').replace(/\\(["'`\\])/g, '$1');
}

function pushCustomCall(out: ReaderUpdate[], p: Json, at: number): void {
  const call = str(p.call_id);
  if (!call) return;
  const name = str(p.name) ?? '?';
  const input = str(p.input) ?? '';
  if (name === 'apply_patch') { pushPatchCall(out, call, at, input); return; }
  // Code mode: the call is a script that runs tools. The commands in it are what there is to show.
  const cmds = Array.from(input.matchAll(CMD_IN_CODE), (m) => unquote(m[1]!));
  if (name === 'exec' && cmds.length > 0) {
    const first = oneLine(cmds[0]!);
    out.push({ op: 'tool', id: call, at, name: 'Bash', target: clip(cmds.length > 1 ? `${first} (+${cmds.length - 1} more)` : first, MAX_TARGET), input: clip(cmds.join('\n\n'), MAX_INPUT) });
    return;
  }
  out.push({ op: 'tool', id: call, at, name, target: clip(oneLine(input.split('\n')[0] ?? ''), MAX_TARGET), input: clip(input, MAX_INPUT) });
}

function pushPatchCall(out: ReaderUpdate[], call: string, at: number, text: string): void {
  const patch = parseApplyPatch(text);
  const files = patch ? patch.files : [];
  const target = files.length === 1 ? files[0]! : files.length > 1 ? `${files.length} files` : '';
  out.push({ op: 'tool', id: call, at, name: 'Edit', target, input: patch ? '' : clip(text, MAX_INPUT), ...(patch ? { patch: patch.patch } : {}) });
}

/**
 * Codex's `apply_patch` text:
 *   *** Begin Patch / *** Update File: p / @@ context / ±lines / *** Add File: p / +lines / *** Delete File: p / *** End Patch
 * as one patch, hunks headed by their file when there is more than one.
 */
export function parseApplyPatch(text: string): { patch: ReaderPatch; files: string[] } | null {
  if (!text.includes('*** Begin Patch')) return null;
  const files: string[] = [];
  const hunks: ReaderPatch['hunks'] = [];
  let cur: { header: string; lines: ReaderPatchLine[] } | null = null;
  let file = '';
  const flush = () => { if (cur) hunks.push(cur); cur = null; };
  for (const raw of text.split('\n')) {
    const l = raw.replace(/\r$/, '');
    let m: RegExpExecArray | null;
    if ((m = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(l))) {
      flush();
      file = m[2]!.trim();
      files.push(file);
      cur = { header: m[1] === 'Add' ? `${file} (new file)` : m[1] === 'Delete' ? `${file} (deleted)` : file, lines: [] };
    } else if ((m = /^\*\*\* Move to: (.+)$/.exec(l))) {
      if (cur) cur.header += ` → ${m[1]!.trim()}`;
    } else if (l.startsWith('@@')) {
      // A change inside a file starts at its anchor; the first one shares the file's header.
      if (cur && cur.lines.length > 0) { const header = `${file} ${l}`.trim(); flush(); cur = { header, lines: [] }; }
      else if (cur && l.trim() !== '@@') cur.header = `${cur.header} ${l}`.trim();
    } else if (l.startsWith('***')) {
      flush();
    } else if (cur) {
      const op = l[0] === '+' || l[0] === '-' ? l[0] : ' ';
      cur.lines.push({ op, text: l[0] === '+' || l[0] === '-' || l[0] === ' ' ? l.slice(1) : l });
    }
  }
  flush();
  if (hunks.length === 0) return null;
  // Single-file patches don't need the file repeated on each hunk.
  const single = files.length === 1;
  const cleaned = hunks.map((h) => ({ header: single ? h.header.replace(file, '').trim() : h.header, lines: h.lines }));
  return { patch: capPatch({ file: single ? file : `${files.length} files`, hunks: cleaned }), files };
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

// ───── other tools ─────

function pushWebSearch(out: ReaderUpdate[], p: Json, at: number): void {
  const id = str(p.id) ?? str(p.call_id);
  if (!id) return;
  const action = isObj(p.action) ? p.action : {};
  const kind = str(action.type);
  const queries = arr(action.queries).map(String);
  const target = str(action.query) ?? queries[0] ?? str(action.url) ?? (kind === 'open_page' ? 'page' : '');
  const name = kind === 'open_page' ? 'WebFetch' : kind === 'find_in_page' ? 'FindInPage' : 'WebSearch';
  out.push({ op: 'tool', id: `web:${id}`, at, name, target: clip(oneLine(target), MAX_TARGET), input: '' });
  if (p.status === 'completed' || p.status === undefined) {
    out.push({ op: 'tool-result', id: `web:${id}`, at, output: clip(queries.length > 1 ? queries.join('\n') : '', MAX_OUTPUT), isError: false });
  }
}

function pushToolSearch(out: ReaderUpdate[], p: Json, at: number): void {
  const call = str(p.call_id);
  if (!call) return;
  const args = parseArgs(p.arguments);
  out.push({ op: 'tool', id: call, at, name: 'ToolSearch', target: clip(oneLine(str(args.query) ?? ''), MAX_TARGET), input: '' });
}

function pushToolSearchOutput(out: ReaderUpdate[], p: Json, at: number): void {
  const call = str(p.call_id);
  if (!call) return;
  const names: string[] = [];
  for (const group of arr(p.tools)) {
    if (!isObj(group)) continue;
    const inner = arr(group.tools).filter(isObj).map((t) => str(t.name) ?? '').filter(Boolean);
    if (inner.length) names.push(...inner); else if (str(group.name)) names.push(String(group.name));
  }
  out.push({ op: 'tool-result', id: call, at, output: names.length ? `${names.length} tool${names.length > 1 ? 's' : ''}: ${names.join(', ')}` : 'no tools found', isError: false });
}

function pushImage(out: ReaderUpdate[], p: Json, at: number): void {
  const id = str(p.id);
  if (!id) return;
  out.push({ op: 'tool', id: `img:${id}`, at, name: 'ImageGen', target: clip(oneLine(str(p.revised_prompt) ?? ''), MAX_TARGET), input: '' });
  if (p.status === 'completed') out.push({ op: 'tool-result', id: `img:${id}`, at, output: 'image generated', isError: false });
}

// ───── results ─────

function toolResult(p: Json, at: number): ReaderUpdate {
  const { text, isError } = outputOf(p.output);
  const truncated = text.length > MAX_OUTPUT;
  return {
    op: 'tool-result',
    id: str(p.call_id) ?? '',
    at,
    output: truncated ? text.slice(0, MAX_OUTPUT) : text,
    isError,
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * The text of a tool's output and whether it failed. The output is a string or a list of text parts; a shell's
 * is sometimes JSON ({output, metadata: {exit_code}}); code mode puts a "Script completed" header in front.
 */
function outputOf(raw: unknown): { text: string; isError: boolean } {
  let text = typeof raw === 'string' ? raw : arr(raw).map((c) => (isObj(c) && typeof c.text === 'string' ? c.text : '')).filter(Boolean).join('');
  let code: number | undefined;
  let failed = false;

  const header = /^Script (completed|failed)[^\n]*\n(?:Wall time[^\n]*\n)?(?:Output:\n)?/.exec(text);
  if (header) { failed = header[1] === 'failed'; text = text.slice(header[0].length); }

  if (text.startsWith('{')) {
    try {
      const j = JSON.parse(text) as unknown;
      if (isObj(j) && typeof j.output === 'string') {
        const meta = isObj(j.metadata) ? j.metadata : j;
        if (typeof meta.exit_code === 'number') code = meta.exit_code;
        text = j.output;
      }
    } catch { /* not JSON after all: show it as it is */ }
  }
  if (code === undefined) {
    const m = /^(?:Exit code|Process exited with code):? (-?\d+)/m.exec(text);
    if (m) code = Number(m[1]);
  }
  return { text, isError: failed || (code !== undefined && code !== 0) || /^aborted by user\b/.test(text) };
}

// ───── where the record is ─────

/** Session id → file, remembered once found so a busy pane does not rescan the date directories every second. */
const located = new Map<string, string>();

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Codex names sessions with UUIDv7, whose first 48 bits are the start time; the file sits under that day (local time). */
function dayDirsFor(sid: string): string[] {
  const ms = parseInt(sid.replace(/-/g, '').slice(0, 12), 16);
  if (!Number.isFinite(ms) || ms <= 0) return [];
  return [-1, 0, 1].map((d) => {
    const t = new Date(ms + d * 86_400_000);
    return `${t.getFullYear()}/${pad(t.getMonth() + 1)}/${pad(t.getDate())}`;
  });
}

async function findIn(dir: string, sid: string): Promise<string | null> {
  let names: string[] = [];
  try { names = await readdir(dir); } catch { return null; }
  const hit = names.find((n) => n.startsWith('rollout-') && n.endsWith(`-${sid}.jsonl`));
  return hit ? resolve(dir, hit) : null;
}

async function newestFirst(dir: string): Promise<string[]> {
  try { return (await readdir(dir)).filter((n) => /^\d+$/.test(n)).sort().reverse(); } catch { return []; }
}

async function locateById(sid: string | undefined): Promise<{ path: string; key: string } | null> {
  if (!sid || !/^[0-9a-f-]{8,}$/i.test(sid)) return null;

  const cached = located.get(sid);
  if (cached && await exists(cached)) return { path: cached, key: sid };

  const root = resolve(process.env.CODEX_HOME || resolve(process.env.HOME ?? '/tmp', '.codex'), 'sessions');
  let found: string | null = null;
  for (const day of dayDirsFor(sid)) {
    found = await findIn(resolve(root, day), sid);
    if (found) break;
  }
  if (!found) {
    // A session resumed days later keeps writing to its first file; if the id says another day, look everywhere, newest first.
    scan: for (const y of await newestFirst(root)) {
      for (const m of await newestFirst(resolve(root, y))) {
        for (const d of await newestFirst(resolve(root, y, m))) {
          found = await findIn(resolve(root, y, m, d), sid);
          if (found) break scan;
        }
      }
    }
  }
  if (!found || !isTranscriptPath(found)) return null;
  located.set(sid, found);
  return { path: found, key: sid };
}

// ───── a Codex that left nothing in meta ─────
//
// Since 0.162 the TUI talks to one shared background server, and Codex runs its hooks there. That server keeps the
// environment of the pane that first started it, so every hook reports that pane's TTYM_SESSION_ID: other panes get
// nothing, and the first one is handed their conversations. A pane's Codex is therefore found as a process under its
// shell, and its conversation among the threads Codex lists for the folder the process runs in.

/** Subcommands that are not a conversation (`resume` and `fork` are). */
const NOT_A_CONVERSATION = new Set(['exec', 'e', 'review', 'login', 'logout', 'mcp', 'mcp-server', 'app-server', 'app', 'completion', 'cloud', 'apply', 'a', 'debug', 'features', 'help', 'sandbox', 'update', 'agents', 'remote-control', 'proto', 'plugin']);

/** The interactive codex under a pane's shell: not `codex exec` and not one of the other subcommands. */
export function findCodexIn(procs: ProcInfo[], shellPid: number): ProcInfo | null {
  return findUnder(procs, shellPid, (tokens) => {
    if ((tokens[0] ?? '').split('/').pop() !== 'codex') return false;
    const first = tokens.slice(1).find((t) => !t.startsWith('-'));
    return !(first && NOT_A_CONVERSATION.has(first));
  });
}

export async function findCodexProcess(shellPid: number): Promise<ProcInfo | null> {
  return findCodexIn(await listProcesses(), shellPid);
}

function cwdOf(pid: number): Promise<string | null> {
  return new Promise((done) => {
    execFile('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], (err, out) => {
      done(err ? null : out.split('\n').find((l) => l.startsWith('n'))?.slice(1) ?? null);
    });
  });
}

type Thread = { id: string; path: string; updated: number };

/** Threads Codex lists for a folder, most recently written first. It keeps them in `state_<n>.sqlite` next to the sessions. */
async function threadsIn(cwd: string): Promise<Thread[]> {
  const home = resolve(process.env.CODEX_HOME || resolve(process.env.HOME ?? '/tmp', '.codex'));
  let names: string[] = [];
  try { names = (await readdir(home)).filter((n) => /^state_\d+\.sqlite$/.test(n)); } catch { return []; }
  const name = names.sort((a, b) => parseInt(b.slice(6), 10) - parseInt(a.slice(6), 10))[0];
  if (!name) return [];
  try {
    const { DatabaseSync } = (await import('node:sqlite')) as unknown as { DatabaseSync: new (path: string, options: { readOnly: boolean }) => { prepare(sql: string): { all(...p: unknown[]): Array<Record<string, unknown>> }; close(): void } };
    const db = new DatabaseSync(resolve(home, name), { readOnly: true });
    try {
      return db.prepare('SELECT id, rollout_path, updated_at_ms FROM threads WHERE cwd = ? AND archived = 0 ORDER BY updated_at_ms DESC LIMIT 8')
        .all(cwd).map((r) => ({ id: String(r.id), path: String(r.rollout_path), updated: Number(r.updated_at_ms) }));
    } finally { db.close(); }
  } catch { return []; }
}

/** pid → its folder, remembered: `lsof` takes a moment, the page asks every second, and a process keeps its folder. */
const cwds = new Map<number, Promise<string | null>>();

async function locateByProcess(proc: ProcInfo, meta: Record<string, unknown>): Promise<{ path: string; key: string } | null> {
  let cwd = cwds.get(proc.pid);
  if (!cwd) { cwd = cwdOf(proc.pid); cwds.set(proc.pid, cwd); if (cwds.size > 64) cwds.delete(cwds.keys().next().value as number); }
  const dir = await cwd;
  if (!dir) return null;
  const threads = await threadsIn(dir);
  // A hook that did reach this pane names its thread exactly; otherwise the one written most recently is the live one.
  const metaId = str(meta.codexSessionId) ?? str(meta.codexLastSessionId);
  const pick = threads.find((t) => t.id === metaId) ?? threads[0];
  if (!pick || !isTranscriptPath(pick.path) || !await exists(pick.path)) return null;
  return { path: pick.path, key: pick.id };
}

async function locateCodex(meta: Record<string, unknown>, ctx: SourceContext): Promise<{ path: string; key: string } | null> {
  const proc = ctx.pid ? await findCodexProcess(ctx.pid) : null;
  const byProcess = proc ? await locateByProcess(proc, meta) : null;
  return byProcess ?? await locateById(str(meta.codexSessionId) ?? str(meta.codexLastSessionId));
}

export const codexSource: LineSource = {
  agent: 'codex',
  locate: locateCodex,
  parse: parseCodexLines,
};
