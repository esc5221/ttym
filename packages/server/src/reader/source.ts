import type { ReaderAgent, ReaderUpdate } from '@ttym/protocol';

/**
 * What it takes to make one agent readable.
 *
 * Everything that differs between agents lives behind these interfaces: where the record is, how it is
 * read, and what its entries mean. The rest of the reader (the HTTP route, the web page) never learns an
 * agent's file format. Adding an agent is a new file implementing one of them and one line in `SOURCES`.
 *
 * Two shapes, by how the record grows:
 *   LineSource    an append-only text file of one record per line (Claude Code, Codex). The reader does the
 *                 incremental reading — byte offsets, whole lines, the tail on a first ask — and the source
 *                 only says what a line means.
 *   CursorSource  anything else (Antigravity's SQLite). The source reads its own record and numbers its
 *                 position itself; `next`/`from` are whatever offsets it understands.
 */

/** What the server knows about the pane besides the agent's own meta. */
export interface SourceContext {
  /** The pane's shell process; agents that leave nothing in meta are found under it. */
  pid?: number;
}

export interface LocatedRecord {
  path: string;
  /**
   * Names the record. It changes when the agent starts a new one (a cleared or resumed
   * conversation), which tells the reader to start over.
   */
  key: string;
}

interface SourceBase {
  agent: ReaderAgent;
  /** The record holding this session's conversation, or null while there is none. */
  locate(meta: Record<string, unknown>, ctx: SourceContext): Promise<LocatedRecord | null>;
}

export interface LineSource extends SourceBase {
  /** Lines of that file → updates. Pure: the same lines always give the same updates. */
  parse(lines: string[]): ReaderUpdate[];
}

export interface CursorRead {
  /** Where to continue from (the `after` of the next ask). */
  next: number;
  /** Where the updates begin; 0 means the record's start, so there is nothing earlier to load. */
  from: number;
  /** True when the updates replace everything the client holds. */
  reset: boolean;
  updates: ReaderUpdate[];
}

export interface CursorSource extends SourceBase {
  /**
   * `after`: the previous answer's `next`, or null on the first ask. `before` asks for the page ahead of
   * an offset (an earlier answer's `from`) instead. `sameRecord` is false when the client holds another
   * record's offsets, which are then meaningless.
   */
  read(found: LocatedRecord, req: { after: number | null; before: number | null; sameRecord: boolean }): Promise<CursorRead>;
}

export type TranscriptSource = LineSource | CursorSource;

export const isCursorSource = (s: TranscriptSource): s is CursorSource => typeof (s as CursorSource).read === 'function';
