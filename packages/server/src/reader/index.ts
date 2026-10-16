import type { ReaderAgent, ReaderFeed } from '@ttym/protocol';
import { agentKindOf } from '../agent-providers.js';
import { agySource, findAgyProcess } from './agy.js';
import { claudeSource } from './claude.js';
import { codexSource, findCodexProcess } from './codex.js';
import { readLinesBefore, readNewLines } from './feed.js';
import { isCursorSource, type SourceContext, type TranscriptSource } from './source.js';

/**
 * Reader mode's server half: a session → what is new in its conversation.
 *
 * To make another agent readable, implement `TranscriptSource` for it
 * (see source.ts) and list it here.
 */
const SOURCES: TranscriptSource[] = [claudeSource, codexSource, agySource];

export interface ReaderRequest {
  /** Byte offset from a previous answer's `next`; null on the first ask. */
  after: number | null;
  /** The previous answer's `key`; a mismatch means the record changed under the client. */
  key: string | null;
  /** Instead of what is new: the lines ahead of this offset (an earlier answer's `from`). */
  before?: number | null;
}

/**
 * Which agent the pane runs. The hooks leave claude and codex in meta; Antigravity has none, and Codex's reach a
 * pane only when it runs its own server, so both are also found as a process under the pane's shell, and what runs now outranks what meta remembers from before.
 */
async function agentOf(meta: Record<string, unknown>, ctx: SourceContext): Promise<ReaderAgent | null> {
  if (ctx.pid && await findAgyProcess(ctx.pid)) return 'agy';
  if (ctx.pid && await findCodexProcess(ctx.pid)) return 'codex';
  return agentKindOf(meta);
}

export async function readerFeed(meta: Record<string, unknown>, req: ReaderRequest, ctx: SourceContext = {}): Promise<ReaderFeed> {
  const agent = await agentOf(meta, ctx);
  const none = (supported: boolean): ReaderFeed => ({ agent, supported, key: null, next: 0, reset: true, from: 0, updates: [] });

  if (!agent) return none(false);
  const source = SOURCES.find((s) => s.agent === agent);
  if (!source) return none(false);

  const found = await source.locate(meta, ctx);
  if (!found) return none(true);

  const sameRecord = req.key === found.key;
  try {
    if (isCursorSource(source)) {
      const read = await source.read(found, { after: sameRecord ? req.after : null, before: sameRecord ? req.before ?? null : null, sameRecord });
      return { agent, supported: true, key: found.key, ...read };
    }
    // A different key is a different file: whatever offset the client holds is meaningless there.
    const after = sameRecord ? req.after : null;
    if (req.before != null && sameRecord) {
      const earlier = await readLinesBefore(found.path, req.before);
      return { agent, supported: true, key: found.key, next: req.before, reset: false, from: earlier.start, updates: source.parse(earlier.lines) };
    }
    const read = await readNewLines(found.path, after);
    return { agent, supported: true, key: found.key, next: read.next, reset: read.reset, from: read.start, updates: source.parse(read.lines) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return none(true);
    throw e;
  }
}
