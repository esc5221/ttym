import type { ReaderAgent, ReaderFeed, ReaderPatch, ReaderUpdate } from '@ttym/api';

/**
 * The page's data: a conversation as an ordered list of blocks.
 *
 * `applyFeed` folds what the server sends (see @ttym/protocol reader.ts) into
 * this. It knows nothing about any agent: a tool call and its result arrive as
 * separate updates and are joined here by id, and everything else is appended.
 * Pure, so the rules (pairing, turn summaries, the queue) are tested without a
 * browser.
 */

export type Block = BlockBody & {
  /** The record of the agent's log this came from, to tell live branches from rolled-back ones (see `link`). */
  entry?: string;
};

type BlockBody =
  | { kind: 'user'; id: string; at: number; text: string; images: number }
  | { kind: 'text'; id: string; at: number; text: string }
  | { kind: 'thinking'; id: string; at: number; text: string }
  | { kind: 'notice'; id: string; at: number; text: string; endsTurn: boolean }
  | { kind: 'boundary'; id: string; at: number; label: string; /** The summary that followed it; filled in by `attachSummaries`. */ summary?: string }
  | { kind: 'summary'; id: string; at: number; text: string }
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
  /** What is shown: `raw` without the branches that were rolled back. */
  blocks: Block[];
  /** Every block received, in order, including the ones on branches that were rolled back. */
  raw: Block[];
  /** How the log's entries descend from each other, in file order. */
  chain: ChainLink[];
  title: string | null;
  queue: QueuedMessage[];
  /** Offset to ask for the page of history above `blocks`; null when they begin at the start of the record. */
  earlier: number | null;
  /** Results whose call is in the page of history not loaded yet, waiting for it. */
  orphans: Record<string, ToolResult>;
}

type ToolResult = Extract<ReaderUpdate, { op: 'tool-result' }>;
export interface ChainLink { entry: string; parent: string | null }

/** The links kept; more than the blocks need, since most entries show nothing. */
const MAX_CHAIN = 20_000;

/** A tab left open for days should not grow without bound. */
export const MAX_BLOCKS = 2000;

export function emptyState(): ReaderState {
  return { key: null, next: 0, agent: null, supported: null, blocks: [], raw: [], chain: [], title: null, queue: [], earlier: null, orphans: {} };
}

export function applyFeed(state: ReaderState, feed: ReaderFeed): ReaderState {
  if (!feed.reset && feed.updates.length === 0 && feed.next === state.next && feed.key === state.key
    && feed.agent === state.agent && feed.supported === state.supported) return state;

  const blocks = feed.reset ? [] : state.raw.slice();
  const chain: ChainLink[] = feed.reset ? [] : state.chain.slice();
  const linked = new Set(chain.map((l) => l.entry));
  const index = new Map<string, number>();
  blocks.forEach((b, i) => index.set(b.id, i));
  let queue = feed.reset ? [] : state.queue.slice();
  let title = feed.reset ? null : state.title;
  const orphans: Record<string, ToolResult> = feed.reset ? {} : { ...state.orphans };

  const add = (b: BlockBody, entry?: string) => {
    if (index.has(b.id)) return; // the same update delivered twice changes nothing
    index.set(b.id, blocks.length);
    blocks.push(entry ? { ...b, entry } : b);
  };

  for (const u of feed.updates) {
    switch (u.op) {
      case 'user': add({ kind: 'user', id: u.id, at: u.at, text: u.text, images: u.images ?? 0 }, u.entry); break;
      case 'text': add({ kind: 'text', id: u.id, at: u.at, text: u.text }, u.entry); break;
      case 'thinking': add({ kind: 'thinking', id: u.id, at: u.at, text: u.text }, u.entry); break;
      case 'notice': add({ kind: 'notice', id: u.id, at: u.at, text: u.text, endsTurn: u.endsTurn === true }, u.entry); break;
      case 'boundary': add({ kind: 'boundary', id: u.id, at: u.at, label: u.label }, u.entry); break;
      case 'summary': add({ kind: 'summary', id: u.id, at: u.at, text: u.text }, u.entry); break;
      case 'tool':
        add({ kind: 'tool', id: u.id, at: u.at, name: u.name, target: u.target, input: u.input, status: 'running', output: '', truncated: false, ...(u.patch ? { patch: u.patch } : {}) }, u.entry);
        break;
      case 'tool-result': {
        // A result whose call is in history we haven't loaded waits for it.
        const i = index.get(u.id);
        const call = i === undefined ? undefined : blocks[i];
        if (i === undefined || call?.kind !== 'tool') { orphans[u.id] = u; break; }
        blocks[i] = withResult(call, u);
        break;
      }
      case 'turn-end': {
        const summary = summarizeTurn(blocks);
        add({ kind: 'turn-end', id: u.id, at: u.at, durationMs: u.durationMs, tools: summary.tools, edited: summary.edited }, u.entry);
        break;
      }
      case 'queue':
        if (u.action === 'enqueue') queue.push({ text: u.text ?? '', system: u.system === true });
        else queue = queue.slice(1); // a dequeue takes the oldest, whoever queued it
        break;
      case 'title': title = u.text; break;
      case 'link':
        if (!linked.has(u.entry)) { linked.add(u.entry); chain.push({ entry: u.entry, parent: u.parent }); }
        break;
    }
  }

  const capped = blocks.length > MAX_BLOCKS ? blocks.slice(blocks.length - MAX_BLOCKS) : blocks;
  const trimmedChain = chain.length > MAX_CHAIN ? chain.slice(chain.length - MAX_CHAIN) : chain;
  return {
    key: feed.key,
    next: feed.next,
    agent: feed.agent,
    supported: feed.supported,
    blocks: shownBlocks(capped, trimmedChain),
    raw: capped,
    chain: trimmedChain,
    title,
    queue,
    // Blocks trimmed off the front leave a gap nothing here can offset into, so there is no loading earlier history after that.
    earlier: capped !== blocks ? null : feed.reset ? (feed.from > 0 ? feed.from : null) : state.earlier,
    orphans,
  };
}

function withResult(call: Extract<Block, { kind: 'tool' }>, u: ToolResult): Block {
  return { ...call, status: u.isError ? 'error' : 'ok', output: u.output, truncated: u.truncated === true, endedAt: u.at, patch: u.patch ?? call.patch };
}

/**
 * The page of history ahead of the blocks we hold. Only the conversation itself is taken from it:
 * what was queued or titled back then says nothing about now. Tool results that were waiting
 * for their call are joined to it here.
 */
export function applyEarlier(state: ReaderState, feed: ReaderFeed): ReaderState {
  if (feed.key !== state.key) return state; // the record changed while the page was on its way
  const page = applyFeed(emptyState(), {
    ...feed,
    reset: true,
    updates: feed.updates.filter((u) => u.op !== 'queue' && u.op !== 'title'),
  });
  const held = new Set(state.raw.map((b) => b.id));
  const orphans = { ...state.orphans };
  const older = page.raw
    .filter((b) => !held.has(b.id))
    .map((b) => {
      if (b.kind !== 'tool') return b;
      const result = orphans[b.id];
      if (!result) return b;
      delete orphans[b.id];
      return withResult(b, result);
    });
  const linked = new Set(state.chain.map((l) => l.entry));
  const chain = [...page.chain.filter((l) => !linked.has(l.entry)), ...state.chain];
  const raw = [...older, ...state.raw];
  return { ...state, raw, chain, blocks: shownBlocks(raw, chain), earlier: feed.from > 0 ? feed.from : null, orphans: { ...page.orphans, ...orphans } };
}

/**
 * The entries still on the conversation: those from which the latest entry of each line of descent
 * can be reached by following parents. Entries off that path were rolled back.
 */
function liveEntries(chain: ChainLink[]): Set<string> {
  const parent = new Map(chain.map((l) => [l.entry, l.parent]));
  const live = new Set<string>();
  const walk = (from: number, to: number) => {
    const within = new Set(chain.slice(from, to).map((l) => l.entry));
    let at: string | null = chain[to - 1]!.entry;
    while (at && within.has(at) && !live.has(at)) { live.add(at); at = parent.get(at) ?? null; }
  };
  let start = 0;
  for (let i = 1; i < chain.length; i++) {
    if (chain[i]!.parent === null) { walk(start, i); start = i; }
  }
  if (chain.length) walk(start, chain.length);
  return live;
}

/**
 * `raw` without what was rolled back. A block whose entry the chain does not know is shown (nothing says
 * it is dead). Turn summaries are counted again over what remains, since the tools a turn ran are the ones on its branch.
 */
function shownBlocks(raw: Block[], chain: ChainLink[]): Block[] {
  if (chain.length === 0) return raw;
  const live = liveEntries(chain);
  const known = new Set(chain.map((l) => l.entry));
  const kept = raw.filter((b) => !b.entry || !known.has(b.entry) || live.has(b.entry));
  if (kept.length === raw.length) return kept;
  const out: Block[] = [];
  for (const b of kept) {
    if (b.kind === 'turn-end') {
      const s = summarizeTurn(out);
      out.push(s.tools === b.tools && s.edited.join('\0') === b.edited.join('\0') ? b : { ...b, tools: s.tools, edited: s.edited });
    } else out.push(b);
  }
  return out;
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
    if (b.kind === 'turn-end' || (b.kind === 'notice' && b.endsTurn)) return null;
    if (b.kind === 'user' || b.kind === 'notice') return b.at || null;
  }
  return null;
}

/**
 * The turn was cut short and nothing has been sent since. An interrupted turn
 * gets no normal end signal, so an agent's "active" flag can stay on for a long
 * time after it; the transcript is what says it is over.
 */
export function interrupted(state: ReaderState): boolean {
  const last = state.blocks[state.blocks.length - 1];
  return last?.kind === 'notice' && last.endsTurn;
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 1) return '<1s';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** On a phone a run of this many tool calls or more folds into one line. */
const GROUP_MIN = 3;
/** Consecutive tool calls become one array entry when `fold` is on and the run is long enough to be worth a line. */
export function groupRuns(blocks: Block[], fold: boolean): (Block | Extract<Block, { kind: 'tool' }>[])[] {
  if (!fold) return blocks;
  const out: (Block | Extract<Block, { kind: 'tool' }>[])[] = [];
  let run: Extract<Block, { kind: 'tool' }>[] = [];
  const flush = () => {
    if (run.length >= GROUP_MIN) out.push(run); else out.push(...run);
    run = [];
  };
  for (const b of blocks) {
    if (b.kind === 'tool') run.push(b); else { flush(); out.push(b); }
  }
  flush();
  return out;
}


/**
 * A compaction is two records, the boundary and the summary that follows it. They are one thing on the page:
 * a summary right after a boundary moves into it. One with no boundary before it (the boundary is in history
 * not loaded yet) stays as it is and is drawn as a compaction of its own.
 */
export function attachSummaries(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    const prev = out[out.length - 1];
    if (b.kind === 'summary' && prev?.kind === 'boundary' && prev.summary === undefined) out[out.length - 1] = { ...prev, summary: b.text };
    else out.push(b);
  }
  return out;
}
