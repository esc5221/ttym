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

/**
 * Every update that makes something to read may name the `entry` (record of the agent's log) it came
 * from. Logs that can be rewound are trees: after a rollback the abandoned messages stay in the file
 * as a dead branch, and `link` updates say how entries descend from each other so a client can tell
 * the branch that is still the conversation from the ones that are not.
 */
export type ReaderUpdate =
  /** Something the person typed (or a slash command they ran). */
  | { op: 'user'; id: string; at: number; text: string; images?: number; entry?: string }
  /** The agent's words. Markdown. */
  | { op: 'text'; id: string; at: number; text: string; entry?: string }
  /** The agent's reasoning, when the record keeps any. Not emitted when empty. */
  | { op: 'thinking'; id: string; at: number; text: string; entry?: string }
  /**
   * A tool call has started. `target` is the one-line label (the file, the
   * command, the pattern); `input` is the expanded text of the call; `patch`
   * is present when the call itself says what will change (an edit).
   */
  | { op: 'tool'; id: string; at: number; name: string; target: string; input: string; patch?: ReaderPatch; entry?: string }
  /** A tool call has finished. `patch`, when present, replaces the one on the call. */
  | { op: 'tool-result'; id: string; at: number; output: string; isError: boolean; truncated?: boolean; patch?: ReaderPatch }
  /** An event that is neither a person nor the agent: a finished background task, an interruption. */
  /** `endsTurn`: the agent stopped what it was doing without a normal end of turn (the person interrupted it). */
  | { op: 'notice'; id: string; at: number; text: string; endsTurn?: true; entry?: string }
  /** The conversation was compacted here. */
  | { op: 'boundary'; id: string; at: number; label: string; entry?: string }
  /** The agent finished a turn. */
  | { op: 'turn-end'; id: string; at: number; durationMs: number; entry?: string }
  /**
   * A message waiting for the agent's next turn. `system` marks one the agent
   * queued for itself (a task notification), which a reader does not show but
   * must still count: a dequeue pops the oldest entry whoever queued it.
   */
  | { op: 'queue'; at: number; action: 'enqueue' | 'dequeue'; text?: string; system?: boolean }
  | { op: 'title'; text: string }
  /**
   * `entry` follows `parent` in the log's tree; a null parent starts a new line of descent (the first
   * entry, or the one that begins after a compaction). Sent for every entry, readable or not, in
   * file order, because chains pass through entries that show nothing.
   */
  | { op: 'link'; entry: string; parent: string | null };

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
  /**
   * Offset in the record of the first line `updates` were read from. 0 means they start at the
   * record's beginning, so there is nothing earlier to load; otherwise pass it as `before` to get
   * the lines ahead of it.
   */
  from: number;
  updates: ReaderUpdate[];
}
