import { readdir, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ReaderPatch, ReaderPatchLine, ReaderUpdate } from '@ttym/protocol';
import { claudeTranscriptPath } from '../agent-providers.js';
import { isTranscriptPath } from '../agent-turn.js';
import type { TranscriptSource } from './source.js';

/**
 * Claude Code's transcript, read as a conversation.
 *
 * ~/.claude/projects/<project>/<session>.jsonl holds one JSON object per line.
 * One assistant message arrives as several lines (its thinking, its text and
 * each tool call are separate records), and a tool's result comes back as a
 * `user` record that points at the call by id. This file turns that into the
 * agent-neutral updates in @ttym/protocol; nothing outside it knows the shapes
 * below.
 *
 * Shapes seen in real transcripts and handled here:
 *   user.message.content        a string (typed text, slash commands, injected
 *                               wrappers) or an array (tool results, pasted text, images)
 *   user.isMeta                 text the harness injected (skill bodies); not the person
 *   user.toolUseResult          the tool's structured result; Edit carries `structuredPatch`
 *   assistant.message.content   an array of text / thinking / tool_use blocks
 *   system.subtype              turn_duration, compact_boundary (the rest is ignored)
 *   queue-operation             enqueue / dequeue of a message for the next turn
 *   ai-title                    the conversation's generated title
 *   isSidechain                 a subagent's own messages; the main file does not show them
 */

const MAX_OUTPUT = 12_000;
const MAX_INPUT = 4_000;
const MAX_TARGET = 200;
/** A compaction summary is a page or two; the cap only guards against a runaway one. */
const MAX_SUMMARY = 40_000;
const MAX_QUEUE_TEXT = 300;
const MAX_PATCH_LINES = 400;

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function parseClaudeLines(lines: string[]): ReaderUpdate[] {
  const out: ReaderUpdate[] = [];
  for (const line of lines) {
    let e: unknown;
    try { e = JSON.parse(line); } catch { continue; }
    if (!isObj(e) || e.isSidechain === true) continue;
    const entry = str(e.uuid);
    const before = out.length;
    switch (e.type) {
      case 'user': pushUser(out, e); break;
      case 'assistant': pushAssistant(out, e); break;
      case 'system': pushSystem(out, e); break;
      case 'queue-operation': pushQueue(out, e); break;
      case 'ai-title': { const title = str(e.aiTitle); if (title) out.push({ op: 'title', text: title }); break; }
    }
    if (entry) {
      // Everything this record made belongs to it; and its place in the tree is told even when it made nothing
      // (an attachment, a hook summary) — the chain of descent runs through those too.
      for (let i = before; i < out.length; i++) {
        const u = out[i]!;
        if (u.op !== 'tool-result' && u.op !== 'queue' && u.op !== 'title' && u.op !== 'link') out[i] = { ...u, entry };
      }
      // A compaction's logicalParentUuid is no tree edge (it can name a record that came after it), so only parentUuid counts.
      out.splice(before, 0, { op: 'link', entry, parent: str(e.parentUuid) ?? null });
    }
  }
  return out;
}

const atOf = (e: Json): number => Date.parse(str(e.timestamp) ?? '') || 0;
const idOf = (e: Json, at: number, i = 0): string => `${str(e.uuid) ?? at}:${i}`;

// ───── user ─────

function pushUser(out: ReaderUpdate[], e: Json): void {
  const at = atOf(e);
  const content = isObj(e.message) ? e.message.content : undefined;

  // After a compaction the harness writes its summary as a user message; it is not what the person typed.
  if (e.isCompactSummary === true) {
    const text = (typeof content === 'string' ? content
      : Array.isArray(content) ? content.map((b) => (isObj(b) && b.type === 'text' ? str(b.text) ?? '' : '')).join('\n') : '').trim();
    if (text) out.push({ op: 'summary', id: idOf(e, at), at, text: clip(text, MAX_SUMMARY) });
    return;
  }

  if (typeof content === 'string') {
    if (e.isMeta === true) return;
    pushUserText(out, e, at, content, 0);
    return;
  }
  if (!Array.isArray(content)) return;

  const texts: string[] = [];
  let images = 0;
  for (const b of content) {
    if (!isObj(b)) continue;
    if (b.type === 'tool_result') out.push(toolResult(b, e, at));
    else if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
    else if (b.type === 'image') images++;
  }
  if (e.isMeta === true) return;
  pushUserText(out, e, at, texts.join('\n'), images);
}

/**
 * Typed text is plain. Everything else the harness writes into a user message
 * is wrapped in a tag: `<command-name>` is a slash command the person ran,
 * `<task-notification>` is a background task reporting in, and the rest
 * (`<system-reminder>`, `<local-command-stdout>`, caveats) is not for reading.
 */
function pushUserText(out: ReaderUpdate[], e: Json, at: number, raw: string, images: number): void {
  const text = raw.trim();
  const id = idOf(e, at);
  if (!text) {
    if (images) out.push({ op: 'user', id, at, text: '', images });
    return;
  }
  if (text.startsWith('[Request interrupted')) {
    out.push({ op: 'notice', id, at, text: text.replace(/^\[|\]$/g, ''), endsTurn: true });
    return;
  }
  if (text.startsWith('<task-notification>')) {
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1]?.trim();
    out.push({ op: 'notice', id, at, text: clip(summary || 'Background task update', MAX_TARGET) });
    return;
  }
  const command = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1]?.trim();
  if (command) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
    out.push({ op: 'user', id, at, text: args ? `${command} ${args}` : command });
    return;
  }
  if (text.startsWith('<')) return;
  out.push({ op: 'user', id, at, text, ...(images ? { images } : {}) });
}

// ───── assistant ─────

function pushAssistant(out: ReaderUpdate[], e: Json): void {
  const at = atOf(e);
  const content = isObj(e.message) ? e.message.content : undefined;
  if (typeof content === 'string') {
    if (content.trim()) out.push({ op: 'text', id: idOf(e, at), at, text: content });
    return;
  }
  if (!Array.isArray(content)) return;

  content.forEach((b, i) => {
    if (!isObj(b)) return;
    const id = idOf(e, at, i);
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
      out.push({ op: 'text', id, at, text: b.text });
    } else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
      // Current Claude Code keeps only a signature here; there is nothing to read, so nothing to show.
      out.push({ op: 'thinking', id, at, text: b.thinking });
    } else if ((b.type === 'tool_use' || b.type === 'server_tool_use') && typeof b.id === 'string') {
      const name = str(b.name) ?? '?';
      const input = isObj(b.input) ? b.input : {};
      const patch = patchFromInput(name, input);
      out.push({ op: 'tool', id: b.id, at, name, target: targetOf(input), input: inputText(name, input), ...(patch ? { patch } : {}) });
    }
  });
}

/** The one thing worth showing on a collapsed tool line. Same priority as agent-turn.ts's toolLine. */
function targetOf(input: Json): string {
  const pick = input.command ?? input.file_path ?? input.notebook_path ?? input.pattern ?? input.url
    ?? input.query ?? input.description ?? input.prompt ?? input.skill;
  return typeof pick === 'string' ? clip(pick.replace(/\s+/g, ' ').trim(), MAX_TARGET) : '';
}

/** The expanded text of a call. Edits show their patch instead, so they have none. */
function inputText(name: string, input: Json): string {
  if (typeof input.command === 'string') return clip(input.command, MAX_INPUT);
  if (name === 'Edit' || name === 'MultiEdit' || name === 'Write' || name === 'NotebookEdit') return '';
  try { return clip(JSON.stringify(input, null, 2), MAX_INPUT); } catch { return ''; }
}

// ───── tool results ─────

function toolResult(b: Json, e: Json, at: number): ReaderUpdate {
  const text = resultText(b.content);
  const truncated = text.length > MAX_OUTPUT;
  const result = isObj(e.toolUseResult) ? e.toolUseResult : undefined;
  const patch = result ? patchFromResult(result) : undefined;
  return {
    op: 'tool-result',
    id: String(b.tool_use_id ?? ''),
    at,
    output: truncated ? text.slice(0, MAX_OUTPUT) : text,
    isError: b.is_error === true,
    ...(truncated ? { truncated: true } : {}),
    ...(patch ? { patch } : {}),
  };
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (isObj(c) ? (c.type === 'text' ? String(c.text ?? '') : c.type === 'image' ? '[image]' : '') : ''))
    .filter(Boolean)
    .join('\n');
}

// ───── patches ─────

/** What an edit call says it will change, before it has run. */
/** Lines of a text; the newline that ends the last line doesn't start another one. */
function textLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function patchFromInput(name: string, input: Json): ReaderPatch | undefined {
  const file = str(input.file_path) ?? str(input.notebook_path) ?? '';
  if (name === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    return capPatch({ file, hunks: [replaceHunk(input.old_string, input.new_string)] });
  }
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    const hunks = input.edits
      .filter((x): x is Json => isObj(x) && typeof x.old_string === 'string' && typeof x.new_string === 'string')
      .map((x) => replaceHunk(String(x.old_string), String(x.new_string)));
    return hunks.length ? capPatch({ file, hunks }) : undefined;
  }
  if (name === 'Write' && typeof input.content === 'string') {
    return capPatch({ file, hunks: [{ header: 'new file', lines: textLines(input.content).map((text) => ({ op: '+' as const, text })) }] });
  }
  return undefined;
}

function replaceHunk(oldText: string, newText: string) {
  const lines: ReaderPatchLine[] = [];
  if (oldText) for (const text of textLines(oldText)) lines.push({ op: '-', text });
  if (newText) for (const text of textLines(newText)) lines.push({ op: '+', text });
  return { header: '', lines };
}

/** Claude Code's own account of an edit, with line numbers and context. Replaces the one built from the call. */
function patchFromResult(result: Json): ReaderPatch | undefined {
  if (!Array.isArray(result.structuredPatch) || result.structuredPatch.length === 0) return undefined;
  const hunks = [];
  for (const h of result.structuredPatch) {
    if (!isObj(h) || !Array.isArray(h.lines)) continue;
    const lines: ReaderPatchLine[] = [];
    for (const l of h.lines) {
      if (typeof l !== 'string') continue;
      const op = l[0] === '+' || l[0] === '-' ? l[0] : ' ';
      lines.push({ op, text: l.slice(1) });
    }
    hunks.push({ header: `@@ -${Number(h.oldStart) || 0},${Number(h.oldLines) || 0} +${Number(h.newStart) || 0},${Number(h.newLines) || 0} @@`, lines });
  }
  return hunks.length ? capPatch({ file: str(result.filePath) ?? '', hunks }) : undefined;
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

// ───── system / queue ─────

function pushSystem(out: ReaderUpdate[], e: Json): void {
  const at = atOf(e);
  if (e.subtype === 'turn_duration') {
    out.push({ op: 'turn-end', id: idOf(e, at), at, durationMs: Number(e.durationMs) || 0 });
  } else if (e.subtype === 'compact_boundary') {
    const meta = isObj(e.compactMetadata) ? e.compactMetadata : {};
    const pre = Number(meta.preTokens), post = Number(meta.postTokens);
    const label = pre > 0 && post > 0 ? `Conversation compacted · ${tokens(pre)} → ${tokens(post)} tokens` : 'Conversation compacted';
    out.push({ op: 'boundary', id: idOf(e, at), at, label });
  }
}

const tokens = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

function pushQueue(out: ReaderUpdate[], e: Json): void {
  const at = atOf(e);
  if (e.operation === 'enqueue') {
    const text = str(e.content);
    out.push({ op: 'queue', at, action: 'enqueue', ...(text !== undefined ? { text: clip(text, MAX_QUEUE_TEXT) } : {}), system: text === undefined || text.trimStart().startsWith('<') });
  } else if (e.operation === 'dequeue') {
    out.push({ op: 'queue', at, action: 'dequeue' });
  } else if (e.operation === 'remove') {
    // Taken out of the queue by name (merged into the turn that was running). Without the text there is nothing to match.
    const text = str(e.content);
    if (text !== undefined) out.push({ op: 'queue', at, action: 'remove', text: clip(text, MAX_QUEUE_TEXT) });
  } else if (e.operation === 'popAll') {
    out.push({ op: 'queue', at, action: 'clear' });
  }
}

// ───── where the record is ─────

/** Session id → file, remembered once found so a busy pane does not rescan the project dirs every second. */
const located = new Map<string, string>();

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

/**
 * The session's file. The project directory is named after the cwd Claude was
 * started in, which the pane's cwd (what ttym tracks) may have moved on from;
 * when the expected path is missing, find the session id under any project.
 */
async function locateClaude(meta: Record<string, unknown>): Promise<{ path: string; key: string } | null> {
  const sid = str(meta.claudeSessionId) ?? str(meta.claudeLastSessionId);
  if (!sid) return null;

  const cached = located.get(sid);
  if (cached && await exists(cached)) return { path: cached, key: sid };

  const home = process.env.HOME ?? '/tmp';
  const cwd = str(meta.cwd);
  const expected = cwd ? claudeTranscriptPath(cwd, sid, home) : null;
  let found: string | null = expected && await exists(expected) ? expected : null;
  if (!found) {
    const root = resolve(home, '.claude', 'projects');
    let dirs: string[] = [];
    try { dirs = await readdir(root); } catch { /* no Claude Code here */ }
    for (const dir of dirs) {
      const candidate = resolve(root, dir, `${sid}.jsonl`);
      if (await exists(candidate)) { found = candidate; break; }
    }
  }
  if (!found || !isTranscriptPath(found)) return null;
  located.set(sid, found);
  return { path: found, key: sid };
}

export const claudeSource: TranscriptSource = {
  agent: 'claude-code',
  locate: locateClaude,
  parse: parseClaudeLines,
};
