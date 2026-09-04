import { useEffect, useState } from 'react';
import type { PathCandidate } from './paths.js';

/**
 * The small "open" button that appears above a path selected in a pane's
 * terminal. Placed at the pointer, not the cell: xterm's cell→pixel maths
 * is private, and the pointer is where the eye already is.
 *
 * Lives until the next mousedown, Esc, a few seconds, or the open itself.
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

  const go = async () => {
    if (busy) return;
    setBusy(true);
    const err = await onOpen(target.candidate);
    setBusy(false);
    if (err) { setError(err); setTimeout(onDismiss, 1600); } else onDismiss();
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onDismiss(); return; }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void go(); }
    };
    window.addEventListener('keydown', key, true);
    const timer = setTimeout(onDismiss, 6000);
    return () => { window.removeEventListener('keydown', key, true); clearTimeout(timer); };
  }, [target]);

  const label = target.candidate.target.split('/').pop() || target.candidate.target;
  const where = target.candidate.line !== undefined ? `:${target.candidate.line}` : '';
  return (
    <span
      className={`sel-open${error ? ' err' : ''}`}
      style={{ left: Math.max(4, target.x - 12), top: Math.max(2, target.y - 34) }}
      onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
      onClick={(e) => { e.stopPropagation(); if (!error) void go(); }}
      title={target.candidate.target}
    >
      {error ? <span>{error}</span> : (
        <>
          <span>open</span>
          <span className="path">{label}{where}</span>
          <span className="key">⌘⏎</span>
        </>
      )}
    </span>
  );
}
