/**
 * Reader mode — a session's conversation, read from the agent's own record.
 *
 * The terminal screen is a rendering; the agent also writes a transcript
 * (Claude Code: ~/.claude/projects/…/<session>.jsonl). Reader mode draws that
 * record as a page. This file is the contract between the two halves:
 *
 *   server  one parser per agent turns transcript lines into `ReaderUpdate`s
 *   web     one reducer folds updates into blocks and draws them
 *
 * Nothing here names an agent's file format. What an agent has that this
 * vocabulary lacks is dropped by its parser, not smuggled through; what this
 * vocabulary has that an agent lacks simply never appears. A new agent adds a
 * parser on the server and touches nothing on the web.
 *
 * Updates are append-only and ordered, and every one is self-contained: a
 * `tool-result` names its tool by id instead of relying on state from an
 * earlier request. That keeps the server stateless per request — any client may
 * ask from any offset — and puts the (small) pairing logic in the reducer.
 */

export type ReaderAgent = 'claude-code' | 'codex';

/** One line of a diff. `op` is the unified-diff marker: context, added, removed. */
export interface ReaderPatchLine {
  op: ' ' | '+' | '-';
  text: string;
}

export interface ReaderHunk {
  /** "@@ -23,7 +23,17 @@" or any short label; shown above the lines. */
  header: string;
  lines: ReaderPatchLine[];
}

export interface ReaderPatch {
  file: string;
  hunks: ReaderHunk[];
  /** True when the parser cut lines to bound the payload. */
  truncated?: boolean;
}

export type ReaderUpdate =
  /** Something the person typed (or a slash command they ran). */
  | { op: 'user'; id: string; at: number; text: string; images?: number }
  /** The agent's words. Markdown. */
  | { op: 'text'; id: string; at: number; text: string }
  /** The agent's reasoning, when the record keeps any. Not emitted when empty. */
  | { op: 'thinking'; id: string; at: number; text: string }
  /**
   * A tool call has started. `target` is the one-line label (the file, the
   * command, the pattern); `input` is the expanded text of the call; `patch`
   * is present when the call itself says what will change (an edit).
   */
  | { op: 'tool'; id: string; at: number; name: string; target: string; input: string; patch?: ReaderPatch }
  /** A tool call has finished. `patch`, when present, replaces the one on the call. */
  | { op: 'tool-result'; id: string; at: number; output: string; isError: boolean; truncated?: boolean; patch?: ReaderPatch }
  /** An event that is neither a person nor the agent: a finished background task, an interruption. */
  /** `endsTurn`: the agent stopped what it was doing without a normal end of turn (the person interrupted it). */
  | { op: 'notice'; id: string; at: number; text: string; endsTurn?: true }
  /** The conversation was compacted here. */
  | { op: 'boundary'; id: string; at: number; label: string }
  /** The agent finished a turn. */
  | { op: 'turn-end'; id: string; at: number; durationMs: number }
  /**
   * A message waiting for the agent's next turn. `system` marks one the agent
   * queued for itself (a task notification), which a reader does not show but
   * must still count: a dequeue pops the oldest entry whoever queued it.
   */
  | { op: 'queue'; at: number; action: 'enqueue' | 'dequeue'; text?: string; system?: boolean }
  | { op: 'title'; text: string };

export interface ReaderFeed {
  /** Which agent's record this is; null when the session has none. */
  agent: ReaderAgent | null;
  /** False when the session's agent has no parser yet. `updates` is empty then. */
  supported: boolean;
  /**
   * Identifies the record the offsets belong to (for Claude Code, the session id).
   * A client sends it back with `after`; a different key means a different file
   * (the conversation was cleared or resumed) and the answer is a fresh start.
   */
  key: string | null;
  /** Pass back as `after` to continue where this left off. */
  next: number;
  /** True when `updates` replace everything the client holds: first load, a new key, a rewound file. */
  reset: boolean;
  updates: ReaderUpdate[];
}
