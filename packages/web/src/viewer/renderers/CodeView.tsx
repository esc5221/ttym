import { useScrollMemory } from '../useScrollMemory.js';
import { useEffect, useState } from 'react';
import type { ViewItem } from '@ttym/api';
import { completeLines, fetchText, humanSize, viewSrc } from '../content.js';
import { highlightHtml, languageFor, splitHighlightedLines } from '../highlight.js';

const MAX_LINES = 10_000;
/** Above this the grammar is skipped — colouring a 2 MB log buys nothing and costs a second of main thread. */
const HIGHLIGHT_MAX_BYTES = 512 * 1024;

/** Text with line numbers, coloured by the file's grammar when one is known (see highlight.ts). */
export function CodeView({ item }: { item: ViewItem }) {
  const scrollRef = useScrollMemory(item.cap ?? item.id);
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

  if (error) return <div className="viewer-empty viewer-error">{error}</div>;
  if (!data) return <div className="viewer-empty">loading…</div>;
  const note = data.partial
    ? `preview — first ${data.lines.length.toLocaleString()} lines of ${humanSize(data.total)}`
    : `${data.all.toLocaleString()} lines · ${humanSize(data.total)}`;
  return (
    <div className="viewer-scroll" ref={scrollRef}>
      <div className="viewer-note">{note}{data.lang ? <span className="viewer-note-lang">{data.lang}</span> : null}</div>
      <pre className="viewer-code">
        {data.html
          ? data.html.map((line, i) => <span key={i} className="ln" dangerouslySetInnerHTML={{ __html: line + '\n' }} />)
          : data.lines.map((line, i) => <span key={i} className="ln">{line}{'\n'}</span>)}
        {data.all > data.lines.length ? <span className="ln trunc">… {(data.all - data.lines.length).toLocaleString()} more lines</span> : null}
      </pre>
    </div>
  );
}
