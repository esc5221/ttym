import { useScrollMemory } from '../useScrollMemory.js';
import { useEffect, useState } from 'react';
import type { ViewItem } from '@ttym/api';
import { completeLines, fetchText, humanSize, viewSrc } from '../content.js';

const MAX_LINES = 10_000;

/** Plain text with line numbers. No highlighter — the terminal next door has one if it matters. */
export function CodeView({ item }: { item: ViewItem }) {
  const scrollRef = useScrollMemory(item.cap ?? item.id);
  const [data, setData] = useState<{ lines: string[]; total: number; partial: boolean; all: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchText(viewSrc(item)).then((res) => {
      if (cancelled) return;
      const lines = completeLines(res.text, res.partial);
      setData({ lines: lines.slice(0, MAX_LINES), total: res.total, partial: res.partial, all: lines.length });
    }).catch((e) => { if (!cancelled) setError(String(e.message ?? e)); });
    return () => { cancelled = true; };
  }, [item.cap, item.rev]);

  if (error) return <div className="viewer-empty viewer-error">{error}</div>;
  if (!data) return <div className="viewer-empty">loading…</div>;
  const note = data.partial
    ? `preview — first ${data.lines.length.toLocaleString()} lines of ${humanSize(data.total)}`
    : `${data.all.toLocaleString()} lines · ${humanSize(data.total)}`;
  return (
    <div className="viewer-scroll" ref={scrollRef}>
      <div className="viewer-note">{note}</div>
      <pre className="viewer-code">
        {data.lines.map((line, i) => <span key={i} className="ln">{line}{'\n'}</span>)}
        {data.all > data.lines.length ? <span className="ln trunc">… {(data.all - data.lines.length).toLocaleString()} more lines</span> : null}
      </pre>
    </div>
  );
}
