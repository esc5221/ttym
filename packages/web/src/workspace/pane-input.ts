import { beginDragGuard } from '@ttym/ui';
import { uploadDroppedFiles } from '../app-shared.js';
import { useWorkspaceSessions } from './session-context.js';

/**
 * What a pane does with the pointer, apart from drawing: dropping files onto it and
 * selecting text that turns out to be a path. The terminal body and the reader page
 * both sit in the same pane, so both call these instead of each keeping a copy.
 */

/** Marks SessionBody's root, the box the path menu is positioned in; the reader finds its pane's through it. */
export const PANE_BODY_ATTR = 'data-session-body';

/** Handlers for the element that should accept dropped files. Only file drags count: a pane header drag swaps panes. */
export function usePaneFileDrop(sid: number) {
  const ctx = useWorkspaceSessions();
  return {
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      ctx.setFileDropSid(sid);
    },
    onDragLeave: () => ctx.setFileDropSid((cur) => (cur === sid ? null : cur)),
    onDrop: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      ctx.setFileDropSid(null);
      void uploadDroppedFiles(Array.from(e.dataTransfer.files))
        .then((paths) => ctx.insertPathsIntoPane(sid, paths))
        .catch(() => {});
    },
  };
}

/**
 * Call from a left-button mousedown. The selection can end outside the pane (over a neighbour),
 * so mouseup is taken from the window, and iframes are kept from taking the pointer in between.
 * `readText` says where the selected text lives (the terminal's own selection by default);
 * `body` is the box the path menu is placed in (the element that was pressed by default).
 */
export function usePaneSelection(sid: number) {
  const ctx = useWorkspaceSessions();
  return (e: React.MouseEvent, opts: { readText?: () => string; body?: HTMLElement | null } = {}) => {
    if (e.button !== 0) return;
    const body = opts.body ?? e.currentTarget as HTMLElement;
    beginDragGuard();
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mouseup', up, true);
      if (ev.button === 0) ctx.offerSelection(sid, body, ev.clientX, ev.clientY, opts.readText);
    };
    window.addEventListener('mouseup', up, true);
  };
}
