import { useEffect, useState, type RefObject } from 'react';
import { getHost } from '@ttym/ui';
import type { ReaderAgent } from '@ttym/api';
import { contentRows, dockBusy, dockRowCount, dockView, type DockView } from './dock.js';

/**
 * Where the page ends and the real terminal shows through.
 *
 * The page covers the stage from the top down to `bottomPx` above the stage's
 * bottom edge; what is left is the terminal's last rows (the agent's prompt, or
 * its permission dialog). `widthPx` is the terminal's drawn width, so the page's
 * column can be the same width and line up with those rows.
 *
 * While a screen is only partly filled, its prompt sits mid-screen with empty
 * rows below. The hook slides the terminal down by those rows (a CSS transform
 * on its wrapper, so the PTY's size is untouched) to put the prompt at the
 * bottom edge, where a chat input belongs.
 */
export interface DockLayout {
  bottomPx: number;
  /** Room between the terminal's last row and the stage's bottom edge (padding, a key bar); a styled dock stands above it. */
  insetPx: number;
  widthPx: number;
  /** One terminal cell, for choosing a column count that gives a wanted pixel width. */
  cellW: number;
  rows: number;
  /** The input area read as data, for drawing it in the page's style; null if the agent's layout isn't recognised. */
  view: DockView | null;
  /** Whether the screen says a turn is running; null when it can't tell (or while the agent is waiting on a dialog). */
  busy: boolean | null;
}

const HOST_RETRY_MS = 250;

export function useDockLayout(
  stage: RefObject<HTMLElement | null>,
  sid: number,
  agent: ReaderAgent | null,
  waiting: boolean,
  enabled: boolean,
): DockLayout | null {
  const [layout, setLayout] = useState<DockLayout | null>(null);

  useEffect(() => {
    if (!enabled) { setLayout(null); return; }
    let raf = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let teardown: (() => void) | undefined;
    let dead = false;
    let shift = 0;

    const measure = () => {
      raf = 0;
      const host = getHost(sid);
      const stageEl = stage.current;
      const screen = host?.term.element?.querySelector<HTMLElement>('.xterm-screen');
      if (!host || !stageEl || !screen) return;
      const term = host.term;
      const r = screen.getBoundingClientRect();
      const box = stageEl.getBoundingClientRect();
      if (!term.rows || !term.cols || !r.height) return;
      const cellH = r.height / term.rows;
      const buf = term.buffer.active;
      // A line the terminal had to wrap (or re-wrapped when it got narrower) fills several rows; its continuation
      // rows are folded into the row that starts it, so a rule drawn wider than the screen is still one rule.
      const all: string[] = [];
      const continued: boolean[] = [];
      for (let i = 0; i < term.rows; i++) {
        const line = buf.getLine(buf.viewportY + i);
        const text = line?.translateToString(true) ?? '';
        const isContinuation = !!line?.isWrapped && all.length > 0;
        continued.push(isContinuation);
        if (isContinuation) {
          let head = all.length - 1;
          while (head > 0 && continued[head]) head--;
          all[head] += text;
          all.push('');
        } else all.push(text);
      }
      const drawn = contentRows(all);
      const n = dockRowCount(agent, drawn, waiting);
      // `r` was read under the transform applied last time; with it removed, the screen's bottom edge is here.
      const bottomUnshifted = r.bottom - shift;
      const dockTop = drawn.length - n;
      // The styled copy reads the rows without the continuation ones, which hold only the rest of a wrapped line.
      const dockRows: string[] = [];
      let caretY = buf.cursorY - dockTop;
      for (let i = dockTop; i < drawn.length; i++) {
        if (continued[i]) { if (i < buf.cursorY) caretY--; continue; }
        dockRows.push(drawn[i]);
      }
      const view = dockView(agent, dockRows, { x: buf.cursorX, y: caretY }, waiting);
      const nextShift = Math.round((term.rows - drawn.length) * cellH);
      if (nextShift !== shift) { shift = nextShift; host.wrapper.style.transform = shift ? `translateY(${shift}px)` : ''; }
      const next: DockLayout = {
        bottomPx: Math.max(0, Math.round(box.bottom - bottomUnshifted + n * cellH)),
        insetPx: Math.max(0, Math.round(box.bottom - bottomUnshifted)),
        widthPx: Math.round(r.width),
        cellW: r.width / term.cols,
        rows: n,
        view,
        busy: waiting ? null : dockBusy(agent, drawn, term.cols),
      };
      setLayout((prev) => prev && prev.bottomPx === next.bottomPx && prev.insetPx === next.insetPx && prev.widthPx === next.widthPx && prev.rows === next.rows && prev.busy === next.busy && JSON.stringify(prev.view) === JSON.stringify(next.view) ? prev : next);
    };
    // Agents draw text and then move the cursor in separate writes; one more look once the output pauses catches the final caret.
    let settle: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
      clearTimeout(settle);
      settle = setTimeout(() => { if (!raf) raf = requestAnimationFrame(measure); }, 80);
    };

    const attach = () => {
      if (dead) return;
      const host = getHost(sid);
      if (!host?.term.element || !stage.current) { retry = setTimeout(attach, HOST_RETRY_MS); return; }
      const subs = [host.term.onWriteParsed(schedule), host.term.onResize(schedule)];
      const ro = new ResizeObserver(schedule);
      ro.observe(stage.current);
      window.addEventListener('resize', schedule);
      teardown = () => { subs.forEach((d) => d.dispose()); ro.disconnect(); window.removeEventListener('resize', schedule); };
      schedule();
    };
    attach();

    return () => {
      dead = true;
      const host = getHost(sid);
      if (host) host.wrapper.style.transform = '';
      if (raf) cancelAnimationFrame(raf);
      clearTimeout(retry);
      clearTimeout(settle);
      teardown?.();
    };
  }, [stage, sid, agent, waiting, enabled]);

  return layout;
}
