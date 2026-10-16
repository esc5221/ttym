import { useEffect, useState } from 'react';
import { getHost } from '@ttym/ui';
import type { LiveText } from './live.js';
import { readScreenMessage } from './screen-live.js';

const HOST_RETRY_MS = 250;
/** A finished message stays this long if the record never shows it (see `liveVisible`). */
const KEEP_DONE_MS = 10_000;

const letters = (s: string) => (s.match(/[\p{L}\p{N}]/gu) ?? []).join('');

/**
 * The message the agent is writing right now, read off the terminal under the page while `on`.
 *
 * Reads happen when the terminal has parsed new output, at most once a frame (plus one more when the output pauses),
 * and only the last rows of the buffer. Nothing is sent anywhere. A message is the same one while each reading
 * extends the one before; anything else is the next message. It is `done` once the agent's spinner says so, or the
 * last thing drawn is no longer words (a tool call, the prompt).
 */
export function useScreenLive(sid: number, on: boolean): LiveText | null {
  const [live, setLive] = useState<LiveText | null>(null);

  useEffect(() => {
    setLive(null);
    if (!on) return;
    let dead = false;
    let raf = 0;
    let settle: ReturnType<typeof setTimeout> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let expire: ReturnType<typeof setTimeout> | undefined;
    let teardown: (() => void) | undefined;
    let mid = 0;
    let cur: { mid: number; text: string; letters: string; done: boolean } | null = null;
    /** The text of a message that was shown for its time and taken down; it is still on the screen, and is not news. */
    let spent = '';

    const publish = (next: typeof cur) => {
      cur = next;
      setLive((prev) => {
        if (!next) return prev === null ? prev : null;
        if (prev && prev.mid === String(next.mid) && prev.text === next.text && prev.done === next.done) return prev;
        return { mid: String(next.mid), text: next.text, done: next.done };
      });
    };

    const read = () => {
      raf = 0;
      const host = getHost(sid);
      if (!host) return;
      const m = readScreenMessage(host.term.buffer.active);
      const text = m?.text ?? '';
      if (!m || !text.trim()) {
        // Nothing drawn yet for the next message, or a tool call after the words: what was being written is complete.
        if (cur && !cur.done) { publish({ ...cur, done: true }); clearTimeout(expire); expire = setTimeout(takeDown, KEEP_DONE_MS); }
        return;
      }
      if (spent && text === spent) return;
      spent = '';
      const l = letters(text);
      // The same message while each reading extends the one before (it may flip to done and back when a tool row blinks).
      const same = cur !== null && l.startsWith(cur.letters);
      const done = !m.streaming;
      if (same && cur && l === cur.letters && done === cur.done) return;
      if (!same) mid++;
      publish({ mid, text, letters: l, done });
      clearTimeout(expire);
      if (done) expire = setTimeout(takeDown, KEEP_DONE_MS);
    };
    const takeDown = () => { if (cur) spent = cur.text; publish(null); };

    const schedule = () => {
      if (dead) return;
      if (!raf) raf = requestAnimationFrame(read);
      clearTimeout(settle);
      settle = setTimeout(() => { if (!raf && !dead) raf = requestAnimationFrame(read); }, 80);
    };

    const attach = () => {
      if (dead) return;
      const host = getHost(sid);
      if (!host?.term.element) { retry = setTimeout(attach, HOST_RETRY_MS); return; }
      const sub = host.term.onWriteParsed(schedule);
      teardown = () => sub.dispose();
      schedule();
    };
    attach();

    return () => {
      dead = true;
      if (raf) cancelAnimationFrame(raf);
      clearTimeout(settle); clearTimeout(retry); clearTimeout(expire);
      teardown?.();
    };
  }, [sid, on]);

  return live;
}
