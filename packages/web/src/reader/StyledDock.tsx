import { useEffect, useState } from 'react';
import { getHost } from '@ttym/ui';
import type { DockView } from './dock.js';

/**
 * The text an input method is still composing (a Hangul syllable not yet
 * committed). It lives in the terminal's hidden textarea, which this dock covers,
 * so the dock draws it itself at the caret.
 *
 * A syllable that was just committed has gone to the terminal but not come back
 * in the rows yet; it is kept on screen until the rows change (or briefly), so
 * the text doesn't blink out between the two.
 *
 * `rowsSignature` changes whenever the typed text on screen does.
 */
function useComposition(sid: number, rowsSignature: string): string {
  const [live, setLive] = useState('');
  const [held, setHeld] = useState('');

  useEffect(() => {
    let area: HTMLTextAreaElement | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const update = (e: CompositionEvent) => setLive(e.data ?? '');
    const end = (e: CompositionEvent) => { setHeld((h) => h + (e.data ?? '')); setLive(''); };
    // The terminal's textarea exists only once it is opened; look again until it does.
    const attach = () => {
      area = getHost(sid)?.term.textarea;
      if (!area) { retry = setTimeout(attach, 200); return; }
      area.addEventListener('compositionupdate', update);
      area.addEventListener('compositionend', end);
    };
    attach();
    return () => {
      clearTimeout(retry);
      area?.removeEventListener('compositionupdate', update);
      area?.removeEventListener('compositionend', end);
    };
  }, [sid]);

  useEffect(() => { setHeld(''); }, [rowsSignature]);
  useEffect(() => {
    if (!held) return;
    const t = setTimeout(() => setHeld(''), 600);
    return () => clearTimeout(t);
  }, [held]);

  return held + live;
}

/**
 * The input area drawn in the page's own style instead of as terminal rows.
 *
 * It is a picture of the real terminal rows beneath it: nothing here takes
 * input. Typing still goes to the terminal (which keeps focus), and a click on
 * a dialog option sends that option's number to it, the same key the agent
 * itself accepts.
 */
export function StyledDock({ sid, view }: { sid: number; view: DockView }) {
  const focusTerminal = () => getHost(sid)?.focusTerminal();
  const composing = useComposition(sid, view.kind === 'prompt' ? view.lines.join('\n') : '');
  if (view.kind === 'dialog') {
    const choose = (n: number) => { getHost(sid)?.term.input(String(n)); focusTerminal(); };
    return (
      <div className="rd-approval">
        {view.title ? <div className="rd-ap-title">{view.title}</div> : null}
        {view.detail.length ? <pre className="rd-ap-detail">{view.detail.map((l) => l.trim()).join('\n')}</pre> : null}
        {view.question ? <div className="rd-ap-q">{view.question}</div> : null}
        {view.options.map((o) => (
          <button key={o.n} type="button" className={`rd-opt${o.selected ? ' sel' : ''}`} onClick={() => choose(o.n)}>
            <span className="rd-opt-n">{o.n}.</span><span>{o.label}</span>
          </button>
        ))}
        {view.hint ? <div className="rd-ap-hint">{view.hint}</div> : null}
      </div>
    );
  }
  return (
    <div className="rd-composer-wrap">
      <div className="rd-composer" onMouseUp={focusTerminal}>
        {view.lines.map((line, i) => {
          // The agent sometimes parks the terminal cursor outside the prompt; text being composed still has to be seen, so it goes at the end.
          const caret = view.caret ?? (composing && i === view.lines.length - 1 ? { line: i, col: Infinity } : null);
          return (
            <div key={i} className="rd-crow">
              <span className="rd-pm">{i === 0 ? '❯' : ' '}</span>
              <span className="rd-ctext">{caret?.line === i ? <WithCaret text={line} col={caret.col} composing={composing} /> : line || ' '}</span>
            </div>
          );
        })}
      </div>
      <div className="rd-meta">
        {view.status.map((parts, i) => <div key={i} className="rd-meta-row">{parts.map((p, j) => <span key={j}>{p}</span>)}</div>)}
      </div>
    </div>
  );
}

/** Terminal cells a character takes: East Asian wide and fullwidth forms take two. */
const cellWidth = (ch: string): number => {
  const c = ch.codePointAt(0) ?? 0;
  return (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3)
    || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60)
    || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) ? 2 : 1;
};

function WithCaret({ text, col, composing }: { text: string; col: number; composing: string }) {
  let used = 0;
  let at = 0;
  const chars = Array.from(text);
  while (at < chars.length && used + cellWidth(chars[at]) <= col) used += cellWidth(chars[at++]);
  const under = chars[at];
  return (
    <>
      {chars.slice(0, at).join('')}
      {/* the terminal row ends where the text does, so spaces typed at the end only show in the caret's column */}
      {at >= chars.length && Number.isFinite(col) && used < col ? ' '.repeat(col - used) : null}
      {composing ? <span className="rd-ime">{composing}</span> : null}
      <span className="rd-caret">{under ?? ' '}</span>
      {chars.slice(at + 1).join('')}
    </>
  );
}
