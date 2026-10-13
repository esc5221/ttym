import { open } from 'node:fs/promises';

/**
 * Reading an append-only transcript a piece at a time.
 *
 * A reader asks "what is new since byte N?". The answer is whole lines only: a
 * writer may be in the middle of a line when we look, and half a JSON object
 * is no use to anyone. `next` always lands just past a newline, so asking
 * again from `next` picks up exactly where this left off.
 *
 * The first ask (no offset) takes the tail of the file instead of the whole
 * of it. Transcripts of long sessions run to tens of megabytes, and a page
 * that opens on the last few screens does not need the rest.
 */

export interface LineRead {
  /** Complete lines in file order. Blank lines are dropped. */
  lines: string[];
  /** Byte offset to pass as `after` next time. */
  next: number;
  /** Byte offset where the first of `lines` begins. */
  start: number;
  /** True when `lines` do not continue from the offset that was asked about. */
  reset: boolean;
}

export interface FeedLimits {
  /** How much of the tail the first read takes. */
  initialBytes: number;
  /** The most one read will take after an offset; a bigger gap starts over from the tail. */
  maxBytes: number;
}

export const DEFAULT_FEED_LIMITS: FeedLimits = { initialBytes: 2 * 1024 * 1024, maxBytes: 4 * 1024 * 1024 };

const NEWLINE = 0x0a;

/**
 * Lines of `path` from byte `after` on. `after: null` is the first ask. An
 * offset past the end of the file means it was rewritten shorter; that is a
 * fresh start too.
 */
export async function readNewLines(path: string, after: number | null, limits: FeedLimits = DEFAULT_FEED_LIMITS): Promise<LineRead> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();

    let start: number;
    let reset = false;
    if (after === null || after < 0 || after > size || size - after > limits.maxBytes) {
      reset = true;
      start = Math.max(0, size - limits.initialBytes);
    } else {
      start = after;
    }
    if (start >= size) return { lines: [], next: size, start: size, reset };

    // A tail window can begin in the middle of a line. Read one byte before it:
    // if that byte is a newline the window starts on a line, otherwise the
    // first fragment is the end of a line we are not showing and is dropped.
    const fromMidFile = reset && start > 0;
    const readStart = fromMidFile ? start - 1 : start;
    const buf = Buffer.alloc(size - readStart);
    const { bytesRead } = await fh.read(buf, 0, buf.length, readStart);
    const bytes = buf.subarray(0, bytesRead);

    let from = 0;
    if (fromMidFile) {
      if (bytes[0] === NEWLINE) from = 1;
      else {
        const firstNewline = bytes.indexOf(NEWLINE, 1);
        from = firstNewline < 0 ? bytes.length : firstNewline + 1;
      }
    }
    const lastNewline = bytes.lastIndexOf(NEWLINE);
    if (lastNewline < from) return { lines: [], next: readStart + from, start: readStart + from, reset };

    const text = bytes.subarray(from, lastNewline + 1).toString('utf8');
    const lines = text.split('\n').filter((l) => l.length > 0);
    return { lines, next: readStart + lastNewline + 1, start: readStart + from, reset };
  } finally {
    await fh.close();
  }
}

/**
 * The lines just ahead of byte `before`, which must be where a line begins (an earlier answer's
 * `start`). Takes up to `initialBytes` of them; `start` is where the first returned line begins,
 * 0 once the beginning of the file has been reached.
 */
export async function readLinesBefore(path: string, before: number, limits: FeedLimits = DEFAULT_FEED_LIMITS): Promise<{ lines: string[]; start: number }> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const end = Math.min(Math.max(0, before), size);
    if (end === 0) return { lines: [], start: 0 };
    const windowStart = Math.max(0, end - limits.initialBytes);
    // As with the tail: a window that begins mid-file may begin mid-line, so look one byte earlier and drop a cut line.
    const readStart = windowStart > 0 ? windowStart - 1 : 0;
    const buf = Buffer.alloc(end - readStart);
    const { bytesRead } = await fh.read(buf, 0, buf.length, readStart);
    const bytes = buf.subarray(0, bytesRead);

    let from = 0;
    if (windowStart > 0) {
      if (bytes[0] === NEWLINE) from = 1;
      else {
        const firstNewline = bytes.indexOf(NEWLINE, 1);
        from = firstNewline < 0 ? bytes.length : firstNewline + 1;
      }
    }
    const text = bytes.subarray(from).toString('utf8');
    return { lines: text.split('\n').filter((l) => l.length > 0), start: readStart + from };
  } finally {
    await fh.close();
  }
}
