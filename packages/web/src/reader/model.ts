import type { ReaderAgent, ReaderFeed, ReaderPatch } from '@ttym/api';

/**
 * The page's data: a conversation as an ordered list of blocks.
 *
 * `applyFeed` folds what the server sends (see @ttym/protocol reader.ts) into
 * this. It knows nothing about any agent: a tool call and its result arrive as
 * separate updates and are joined here by id, and everything else is appended.
 * Pure, so the rules (pairing, turn summaries, the queue) are tested without a
 * browser.
 */

export type Block =
  | { kind: 'user'; id: string; at: number; text: string; images: number }
  | { kind: 'text'; id: string; at: number; text: string }
  | { kind: 'thinking'; id: string; at: number; text: string }
  | { kind: 'notice'; id: string; at: number; text: string }
  | { kind: 'boundary'; id: string; at: number; label: string }
  | {
      kind: 'tool'; id: string; at: number; name: string; target: string; input: string;
      status: 'running' | 'ok' | 'error'; output: string; truncated: boolean; endedAt?: number; patch?: ReaderPatch;
    }
  | { kind: 'turn-end'; id: string; at: number; durationMs: number; tools: number; edited: string[] };

export interface QueuedMessage { text: string; system: boolean }

export interface ReaderState {
  /** Which record `next` belongs to; send both back to the server. */
  key: string | null;
  next: number;
  agent: ReaderAgent | null;
  /** Null until the server has answered once. */
  supported: boolean | null;
  blocks: Block[];
  title: string | null;
  queue: QueuedMessage[];
}

/** A tab left open for days should not grow without bound. */
export const MAX_BLOCKS = 2000;

export function emptyState(): ReaderState {
  return { key: null, next: 0, agent: null, supported: null, blocks: [], title: null, queue: [] };
}

export function applyFeed(state: ReaderState, feed: ReaderFeed): ReaderState {
  if (!feed.reset && feed.updates.length === 0 && feed.next === state.next && feed.key === state.key
    && feed.agent === state.agent && feed.supported === state.supported) return state;

  const blocks = feed.reset ? [] : state.blocks.slice();
  const index = new Map<string, number>();
  blocks.forEach((b, i) => index.set(b.id, i));
  let queue = feed.reset ? [] : state.queue.slice();
  let title = feed.reset ? null : state.title;

  const add = (b: Block) => {
    if (index.has(b.id)) return; // the same update delivered twice changes nothing
    index.set(b.id, blocks.length);
    blocks.push(b);
  };

  for (const u of feed.updates) {
    switch (u.op) {
      case 'user': add({ kind: 'user', id: u.id, at: u.at, text: u.text, images: u.images ?? 0 }); break;
      case 'text': add({ kind: 'text', id: u.id, at: u.at, text: u.text }); break;
      case 'thinking': add({ kind: 'thinking', id: u.id, at: u.at, text: u.text }); break;
      case 'notice': add({ kind: 'notice', id: u.id, at: u.at, text: u.text }); break;
      case 'boundary': add({ kind: 'boundary', id: u.id, at: u.at, label: u.label }); break;
      case 'tool':
        add({ kind: 'tool', id: u.id, at: u.at, name: u.name, target: u.target, input: u.input, status: 'running', output: '', truncated: false, ...(u.patch ? { patch: u.patch } : {}) });
        break;
      case 'tool-result': {
        // A result whose call is outside the window we hold has nothing to attach to.
        const i = index.get(u.id);
        const call = i === undefined ? undefined : blocks[i];
        if (i === undefined || call?.kind !== 'tool') break;
        blocks[i] = { ...call, status: u.isError ? 'error' : 'ok', output: u.output, truncated: u.truncated === true, endedAt: u.at, patch: u.patch ?? call.patch };
        break;
      }
      case 'turn-end': {
        const summary = summarizeTurn(blocks);
        add({ kind: 'turn-end', id: u.id, at: u.at, durationMs: u.durationMs, tools: summary.tools, edited: summary.edited });
        break;
      }
      case 'queue':
        if (u.action === 'enqueue') queue.push({ text: u.text ?? '', system: u.system === true });
        else queue = queue.slice(1); // a dequeue takes the oldest, whoever queued it
        break;
      case 'title': title = u.text; break;
    }
  }

  return {
    key: feed.key,
    next: feed.next,
    agent: feed.agent,
    supported: feed.supported,
    blocks: blocks.length > MAX_BLOCKS ? blocks.slice(blocks.length - MAX_BLOCKS) : blocks,
    title,
    queue,
  };
}

/** The tools and edited files of the turn that is ending: everything since the last prompt or turn end. */
function summarizeTurn(blocks: Block[]): { tools: number; edited: string[] } {
  let tools = 0;
  const edited = new Set<string>();
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.kind === 'user' || b.kind === 'turn-end') break;
    if (b.kind !== 'tool') continue;
    tools++;
    if (b.patch?.file && b.status !== 'error') edited.add(b.patch.file);
  }
  return { tools, edited: [...edited].reverse() };
}

/** Messages the person queued for the agent's next turn. The agent's own are not for reading. */
export function pendingMessages(state: ReaderState): string[] {
  return state.queue.filter((q) => !q.system && q.text.trim()).map((q) => q.text);
}

/** When the turn in progress began: the last prompt or notice after the last finished turn. */
export function turnStartedAt(state: ReaderState): number | null {
  for (let i = state.blocks.length - 1; i >= 0; i--) {
    const b = state.blocks[i];
    if (b.kind === 'turn-end') return null;
    if (b.kind === 'user' || b.kind === 'notice') return b.at || null;
  }
  return null;
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 1) return '<1s';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
