import type { Block } from './model.js';

/**
 * The message the agent is writing now, as the page holds it. Its record entry does not exist until the message
 * ends, so for that long this is the only copy; `visibleLive` says when the record has caught up and this goes away.
 */
export interface LiveText {
  mid: string;
  text: string;
  done: boolean;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])\s/;

/**
 * The text cut into top-level markdown blocks at blank lines, the way a reader of a stream wants it: every block
 * but the last is `closed` (its end has been seen, so it will never change and is rendered once), and `open` is the
 * block still being written. A blank line inside a code fence does not end the block; neither does one before an
 * indented line (a list item's continuation) or before the next item of a list, which keeps a list in one piece.
 * A block is closed only after the whole line that follows it has arrived, so a block never reopens.
 */
export function splitMarkdown(text: string): { closed: string[]; open: string } {
  const lines = text.split('\n');
  // Without a final newline the last line is still being written, so it cannot yet say what the blank lines before it were.
  const partial = text.endsWith('\n') ? -1 : lines.length - 1;
  const closed: string[] = [];
  let cur: string[] = [];
  let fence: { ch: string; len: number } | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (fence) {
      cur.push(line);
      const m = FENCE.exec(line);
      if (m && m[1]![0] === fence.ch && m[1]!.length >= fence.len && line.trim() === m[1]) fence = null;
      i++;
      continue;
    }
    if (line.trim() !== '') {
      const m = FENCE.exec(line);
      if (m) fence = { ch: m[1]![0]!, len: m[1]!.length };
      cur.push(line);
      i++;
      continue;
    }
    // A run of blank lines: what follows decides whether it ends the block.
    let j = i;
    while (j < lines.length && lines[j]!.trim() === '') j++;
    if (j >= lines.length || j === partial) { cur.push(...lines.slice(i)); break; } // nothing after it yet: still open
    const next = lines[j]!;
    const inList = cur.length > 0 && LIST_ITEM.test(cur[0]!);
    if (/^\s/.test(next) || (inList && LIST_ITEM.test(next))) {
      cur.push(...lines.slice(i, j));
    } else {
      if (cur.length) closed.push(cur.join('\n'));
      cur = [];
    }
    i = j;
  }
  return { closed, open: cur.join('\n') };
}

/** Block ids at the moment a message was first seen: whatever is not among them came after it began. */
export function idsOf(blocks: Block[]): Set<string> {
  return new Set(blocks.map((b) => b.id));
}

const lettersOf = (s: string) => (s.match(/[\p{L}\p{N}]/gu) ?? []).join('');
/** A fence line with its language tag (```python); the terminal draws the tag, if at all, in its own way. */
const FENCE_INFO = /^(\s*(?:`{3,}|~{3,}))[^\n]*$/gm;
const SAME_FROM = 8;
const SAME_LEN = 60;

/**
 * Whether a record block is the message being previewed. The preview is read off a terminal and the record has the
 * agent's own text, so they are compared by their words, not their characters (the terminal does not draw `**`, a
 * fence's language, or the bars of a table), and by their start, since the preview of a message that is still
 * being written has only a start.
 */
export function sameWords(live: string, recordText: string): boolean {
  const a = lettersOf(live.replace(FENCE_INFO, '$1'));
  // The record keeps a fence's language tag (```python); the terminal does not draw it.
  const b = lettersOf(recordText.replace(FENCE_INFO, '$1'));
  if (a.length < SAME_FROM || b.length < SAME_FROM) return false;
  const k = Math.min(SAME_LEN, a.length, b.length);
  return a.slice(0, k) === b.slice(0, k);
}

/**
 * Whether the preview still belongs on the page. It goes when the record has the message (a text block, new since the
 * message began, with the same words), or when the turn moved on without it: a new prompt, or the turn ended (an
 * interruption leaves no entry for a half-written message).
 */
export function liveVisible(live: LiveText | null, blocks: Block[], seen: Set<string>): boolean {
  if (!live || live.text.trim() === '') return false;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (seen.has(b.id)) break;
    if (b.kind === 'user' || b.kind === 'turn-end' || (b.kind === 'notice' && b.endsTurn)) return false;
    if (b.kind === 'text' && sameWords(live.text, b.text)) return false;
  }
  // A finished message the page meets after its record has it (it is among the blocks from the start).
  if (live.done) {
    for (let i = blocks.length - 1, n = 0; i >= 0 && n < 12; i--, n++) {
      const b = blocks[i]!;
      if (b.kind === 'user') break;
      if (b.kind === 'text' && sameWords(live.text, b.text)) return false;
    }
  }
  return true;
}
