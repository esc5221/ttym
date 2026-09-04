import { useScrollMemory } from '../useScrollMemory.js';
import { useEffect, useRef, useState } from 'react';
import type { ViewItem } from '@ttym/api';
import { completeLines, fetchText, humanSize, viewSrc } from '../content.js';
import { highlightHtml, languageFor, splitHighlightedLines } from '../highlight.js';

const MAX_LINES = 10_000;
/** Above this the grammar is skipped — colouring a 2 MB log buys nothing and costs a second of main thread. */
const HIGHLIGHT_MAX_BYTES = 512 * 1024;

/** Text with line numbers, coloured by the file's grammar when one is known (see highlight.ts). */
export function CodeView({ item, jump }: { item: ViewItem; jump?: { line: number; col?: number; nonce: number } }) {
  const scrollRef = useScrollMemory(item.cap ?? item.id);
  const preRef = useRef<HTMLPreElement | null>(null);
  const [hit, setHit] = useState<number | null>(null);
  const [data, setData] = useState<{ lines: string[]; html: string[] | null; lang: string | null; total: number; partial: boolean; all: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchText(viewSrc(item));
        if (cancelled) return;
        const all = completeLines(res.text, res.partial);
        const lines = all.slice(0, MAX_LINES);
        const lang = languageFor(item.name);
        let html: string[] | null = null;
        if (lang && res.text.length <= HIGHLIGHT_MAX_BYTES) {
          const colored = await highlightHtml(lines.join('\n'), lang);
          if (cancelled) return;
          if (colored !== null) html = splitHighlightedLines(colored);
        }
        setData({ lines, html, lang, total: res.total, partial: res.partial, all: all.length });
      } catch (e) {
        if (!cancelled) setError(String((e as Error).message ?? e));
      }
    })();
    return () => { cancelled = true; };
  }, [item.cap, item.rev]);

  // `a.ts:12` from the terminal: scroll the line into the middle and flash it.
  useEffect(() => {
    if (!jump || !data) return;
    const el = preRef.current?.children[jump.line - 1] as HTMLElement | undefined;
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    setHit(jump.line);
    const t = setTimeout(() => setHit(null), 1800);
    return () => clearTimeout(t);
  }, [jump?.nonce, data !== null]);

  if (error) return <div className="viewer-empty viewer-error">{error}</div>;
  if (!data) return <div className="viewer-empty">loading…</div>;
  const note = data.partial
    ? `preview — first ${data.lines.length.toLocaleString()} lines of ${humanSize(data.total)}`
    : `${data.all.toLocaleString()} lines · ${humanSize(data.total)}`;
  return (
    <div className="viewer-scroll" ref={scrollRef}>
      <div className="viewer-note">{note}{data.lang ? <span className="viewer-note-lang">{data.lang}</span> : null}</div>
      <pre className="viewer-code" ref={preRef}>
        {data.html
          ? data.html.map((line, i) => <span key={i} className={`ln${hit === i + 1 ? ' hit' : ''}`} dangerouslySetInnerHTML={{ __html: line + '\n' }} />)
          : data.lines.map((line, i) => <span key={i} className={`ln${hit === i + 1 ? ' hit' : ''}`}>{line}{'\n'}</span>)}
        {data.all > data.lines.length ? <span className="ln trunc">… {(data.all - data.lines.length).toLocaleString()} more lines</span> : null}
      </pre>
    </div>
  );
}
