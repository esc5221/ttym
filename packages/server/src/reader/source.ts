import type { ReaderAgent, ReaderUpdate } from '@ttym/protocol';

/**
 * What it takes to make one agent readable.
 *
 * Everything that differs between agents lives behind these two methods: where
 * the record is, and what its lines mean. The rest of the reader (incremental
 * reading, the HTTP route, the web page) never learns an agent's file format.
 * Adding an agent is a new file implementing this and one line in `SOURCES`.
 */
export interface TranscriptSource {
  agent: ReaderAgent;

  /**
   * The file holding this session's record, and a key that names it. The key
   * changes when the agent starts a new record (a cleared or resumed
   * conversation), which tells the reader to start over.
   */
  locate(meta: Record<string, unknown>): Promise<{ path: string; key: string } | null>;

  /** Lines of that file → updates. Pure: the same lines always give the same updates. */
  parse(lines: string[]): ReaderUpdate[];
}
