import type { ReaderFeed } from '@ttym/protocol';
import { agentKindOf } from '../agent-providers.js';
import { claudeSource } from './claude.js';
import { readNewLines } from './feed.js';
import type { TranscriptSource } from './source.js';

/**
 * Reader mode's server half: a session → what is new in its conversation.
 *
 * To make another agent readable, implement `TranscriptSource` for it
 * (see source.ts) and list it here.
 */
const SOURCES: TranscriptSource[] = [claudeSource];

export interface ReaderRequest {
  /** Byte offset from a previous answer's `next`; null on the first ask. */
  after: number | null;
  /** The previous answer's `key`; a mismatch means the record changed under the client. */
  key: string | null;
}

export async function readerFeed(meta: Record<string, unknown>, req: ReaderRequest): Promise<ReaderFeed> {
  const agent = agentKindOf(meta);
  const none = (supported: boolean): ReaderFeed => ({ agent, supported, key: null, next: 0, reset: true, updates: [] });

  if (!agent) return none(false);
  const source = SOURCES.find((s) => s.agent === agent);
  if (!source) return none(false);

  const found = await source.locate(meta);
  if (!found) return none(true);

  // A different key is a different file: whatever offset the client holds is meaningless there.
  const after = req.key === found.key ? req.after : null;
  try {
    const read = await readNewLines(found.path, after);
    return { agent, supported: true, key: found.key, next: read.next, reset: read.reset, updates: source.parse(read.lines) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return none(true);
    throw e;
  }
}
