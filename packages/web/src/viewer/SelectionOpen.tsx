import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PathCandidate } from './paths.js';
import { copyText } from '../app-shared.js';

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
  // 오른쪽 끝에서 놓으면 메뉴가 pane 밖으로 나간다. zen 옆 패널에서는 그 부분이 잘리고
  // 패널에 가려진다. 그려진 폭을 재서 pane 안으로 민다.
  const ref = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    const box = el?.offsetParent as HTMLElement | null;
    if (!el || !box) return;
    const left = Math.max(4, target.x - 12);
    setShift(Math.min(0, box.clientWidth - 4 - (left + el.offsetWidth)));
  }, [target, error, copied]);

  const go = async () => {
    if (busy) return;
    setBusy(true);
    const err = await onOpen(target.candidate);
    setBusy(false);
    if (err) { setError(err); setTimeout(onDismiss, 1600); } else onDismiss();
  };

  const copy = async () => {
    const ok = await copyText(target.candidate.target);
    if (!ok) { setError('copy failed'); setTimeout(onDismiss, 1200); return; }
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
      ref={ref}
      className={`sel-open${error ? ' err' : ''}`}
      style={{ left: Math.max(4, Math.max(4, target.x - 12) + shift), top: Math.max(2, target.y - 66) }}
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
