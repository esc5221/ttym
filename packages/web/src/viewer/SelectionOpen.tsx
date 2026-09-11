import { useEffect, useState } from 'react';
import type { PathCandidate } from './paths.js';

/**
 * The small menu that appears above a path selected in a pane's terminal:
 * "copy path" and under it, nearest the pointer, "open" (the main action) — the
 * absolute path the parser resolved, not the fragment on screen. Placed
 * at the pointer, not the cell: xterm's cell→pixel maths is private, and
 * the pointer is where the eye already is.
 *
 * Lives until the next mousedown, Esc, a few seconds, or an action.
 * On a miss the server's word ("not found") shows in place, then goes.
 */
export interface SelectionTarget {
  sid: number;
  /** Pane-relative pointer position. */
  x: number;
  y: number;
  candidate: PathCandidate;
  /** What the user selected, for the label. */
  text: string;
}

export function SelectionOpen({ target, onOpen, onDismiss }: {
  target: SelectionTarget;
  onOpen: (candidate: PathCandidate) => Promise<string | null>;
  onDismiss: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const go = async () => {
    if (busy) return;
    setBusy(true);
    const err = await onOpen(target.candidate);
    setBusy(false);
    if (err) { setError(err); setTimeout(onDismiss, 1600); } else onDismiss();
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(target.candidate.target); } catch { return; }
    setCopied(true);
    setTimeout(onDismiss, 700);
  };

  // No action shortcuts: ⌘⏎ and ⌘⇧C both belong to the terminal and the apps in it. Esc only dismisses.
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); };
    window.addEventListener('keydown', key, true);
    const timer = setTimeout(onDismiss, 6000);
    return () => { window.removeEventListener('keydown', key, true); clearTimeout(timer); };
  }, [target]);

  const label = target.candidate.target.split('/').pop() || target.candidate.target;
  const where = target.candidate.line !== undefined ? `:${target.candidate.line}` : '';
  return (
    <span
      className={`sel-open${error ? ' err' : ''}`}
      style={{ left: Math.max(4, target.x - 12), top: Math.max(2, target.y - 66) }}
      onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
      // mouseup must not reach the pane: it would read the still-selected text and offer a second menu.
      onMouseUp={(e) => e.stopPropagation()}
      title={target.candidate.target}
    >
      {error ? <span className="sel-open-row">{error}</span> : (
        <>
          <span className="sel-open-row" onClick={(e) => { e.stopPropagation(); void copy(); }}>
            <span>{copied ? 'copied' : 'copy path'}</span>
            <span className="path">{target.candidate.target}</span>
          </span>
          <span className="sel-open-row main" onClick={(e) => { e.stopPropagation(); void go(); }}>
            <span>open</span>
            <span className="path">{label}{where}</span>
          </span>
        </>
      )}
    </span>
  );
}
