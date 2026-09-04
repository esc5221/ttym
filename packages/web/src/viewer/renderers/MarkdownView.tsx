import { useScrollMemory } from '../useScrollMemory.js';
import { useEffect, useState } from 'react';
import type { ViewItem } from '@ttym/api';
import { fetchText, humanSize, viewBase, viewSrc } from '../content.js';
import { highlightHtml, languageForTag } from '../highlight.js';

/**
 * Markdown, rendered here in the app's own type and colours. The parser
 * and sanitiser load on first use — most panes never open a .md.
 *
 * Relative links and images resolve under the tab's /view/<cap>/ prefix,
 * which for a file tab means "the file plus sibling static assets": a
 * README's ./img/x.png works, ./secrets.json does not.
 */
export function MarkdownView({ item }: { item: ViewItem }) {
  const scrollRef = useScrollMemory(item.cap ?? item.id);
  const [html, setHtml] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Markdown is prose; some of it reads better on paper. The choice is this
  // browser's and applies to every markdown tab, not just this one.
  const [light, setLight] = useState<boolean>(() => { try { return window.localStorage.getItem('ttym-viewer-md-light') === '1'; } catch { return false; } });
  const toggleLight = () => setLight((v) => { try { window.localStorage.setItem('ttym-viewer-md-light', v ? '0' : '1'); } catch {} return !v; });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [{ marked }, { default: DOMPurify }, res] = await Promise.all([
          import('marked'), import('dompurify'), fetchText(viewSrc(item)),
        ]);
        if (cancelled) return;
        const raw = marked.parse(res.text, { gfm: true, breaks: true }) as string;
        const clean = DOMPurify.sanitize(raw, { ADD_ATTR: ['target'] });
        const doc = rebase(clean, viewBase(item));
        // Fences carry their tag as `language-xxx`; colour those we have a grammar for.
        // hljs escapes its own output, and the text it reads is already sanitised.
        for (const code of Array.from(doc.querySelectorAll('pre > code'))) {
          const tag = Array.from(code.classList).find((c) => c.startsWith('language-'))?.slice('language-'.length) ?? '';
          const lang = languageForTag(tag);
          if (!lang) continue;
          const colored = await highlightHtml(code.textContent ?? '', lang);
          if (cancelled) return;
          if (colored !== null) code.innerHTML = colored;
        }
        setHtml(doc.body.innerHTML);
        if (res.partial) setNote(`preview — first ${humanSize(res.text.length)} of ${humanSize(res.total)}`);
      } catch (e) {
        if (!cancelled) setError(String((e as Error).message ?? e));
      }
    })();
    return () => { cancelled = true; };
  }, [item.cap, item.rev]);

  if (error) return <div className="viewer-empty viewer-error">{error}</div>;
  if (html === null) return <div className="viewer-empty">loading…</div>;
  return (
    <div className={`viewer-scroll${light ? ' viewer-md-light' : ''}`} ref={scrollRef}>
      <div className="viewer-note">
        <button className="viewer-note-btn" onClick={toggleLight} title="markdown on a light or dark page">{light ? 'dark' : 'light'}</button>
        {note ? <span>{note}</span> : null}
      </div>
      <div className="viewer-md" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

/** Point relative src/href at the tab's base; leave absolute and anchor links alone. Links open outside. */
function rebase(html: string, base: string): Document {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const isRelative = (v: string) => v && !/^(?:[a-z]+:|\/|#)/i.test(v);
  for (const img of Array.from(doc.querySelectorAll('img[src]'))) {
    const src = img.getAttribute('src') ?? '';
    if (isRelative(src)) img.setAttribute('src', base + src.replace(/^\.\//, ''));
  }
  for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
    const href = a.getAttribute('href') ?? '';
    if (href.startsWith('#')) continue;
    if (isRelative(href)) a.setAttribute('href', base + href.replace(/^\.\//, ''));
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noreferrer');
  }
  return doc;
}
