import { useScrollMemory } from '../useScrollMemory.js';
import { useEffect, useState, type ReactNode } from 'react';
import type { ViewItem } from '@ttym/api';
import { fetchText, humanSize, viewSrc } from '../content.js';
import { CodeView } from './CodeView.js';

/** Pretty-printed JSON with token colour. Too big to parse (or cut short) falls back to plain code. */
export function JsonView({ item }: { item: ViewItem }) {
  const scrollRef = useScrollMemory(item.cap ?? item.id);
  const [state, setState] = useState<{ nodes: ReactNode[]; total: number } | { fallback: true } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchText(viewSrc(item)).then((res) => {
      if (cancelled) return;
      if (res.partial) { setState({ fallback: true }); return; }
      try {
        const pretty = JSON.stringify(JSON.parse(res.text), null, 2);
        setState({ nodes: colorize(pretty), total: res.total });
      } catch {
        setState({ fallback: true });
      }
    }).catch((e) => { if (!cancelled) setError(String(e.message ?? e)); });
    return () => { cancelled = true; };
  }, [item.cap, item.rev]);

  if (error) return <div className="viewer-empty viewer-error">{error}</div>;
  if (!state) return <div className="viewer-empty">loading…</div>;
  if ('fallback' in state) return <CodeView item={item} />;
  return (
    <div className="viewer-scroll" ref={scrollRef}>
      <div className="viewer-note">{humanSize(state.total)}</div>
      <pre className="viewer-json">{state.nodes}</pre>
    </div>
  );
}

/** A small tokenizer over pretty-printed JSON: keys, strings, numbers, booleans, null. */
function colorize(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let plain = '';
  let k = 0;
  const flush = () => { if (plain) { out.push(plain); plain = ''; } };
  const span = (cls: string, s: string) => { flush(); out.push(<span key={k++} className={cls}>{s}</span>); };
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < n) { if (text[j] === '\\') j += 2; else if (text[j] === '"') break; else j++; }
      const s = text.slice(i, j + 1);
      let m = j + 1;
      while (m < n && text[m] === ' ') m++;
      span(text[m] === ':' ? 'jk' : 'js', s);
      i = j + 1;
    } else if (c === '-' || (c >= '0' && c <= '9')) {
      const m = /^-?\d+\.?\d*(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 40));
      const s = m ? m[0] : c;
      span('jn', s);
      i += s.length;
    } else if (text.startsWith('true', i)) { span('jb', 'true'); i += 4; }
    else if (text.startsWith('false', i)) { span('jb', 'false'); i += 5; }
    else if (text.startsWith('null', i)) { span('jnull', 'null'); i += 4; }
    else { plain += c; i++; }
  }
  flush();
  return out;
}
