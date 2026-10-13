import { highlightHtml, languageForTag } from '../viewer/highlight.js';

/**
 * The agent's words, as HTML. Same pipeline as the viewer's markdown tab
 * (marked → DOMPurify → highlight.js for fenced code), loaded on first use.
 *
 * Text arrives once and never changes, and the page re-renders often, so
 * results are kept by text. A page of a long conversation would otherwise
 * parse every block again on each poll.
 */

const CACHE_MAX = 400;
const cache = new Map<string, string>();

export function cachedMarkdown(text: string): string | undefined {
  return cache.get(text);
}

export async function renderMarkdown(text: string): Promise<string> {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;

  const [{ marked }, { default: DOMPurify }] = await Promise.all([import('marked'), import('dompurify')]);
  // Single newlines stay soft, as in the agent's own rendering; blank lines make paragraphs.
  const raw = marked.parse(text, { gfm: true, breaks: false }) as string;
  const clean = DOMPurify.sanitize(raw, { ADD_ATTR: ['target'] });
  const doc = new DOMParser().parseFromString(clean, 'text/html');

  for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noreferrer noopener');
  }
  for (const code of Array.from(doc.querySelectorAll('pre > code'))) {
    const tag = Array.from(code.classList).find((c) => c.startsWith('language-'))?.slice('language-'.length) ?? '';
    const lang = languageForTag(tag);
    if (!lang) continue;
    // hljs escapes its own output, and the text it reads has already been sanitised.
    const colored = await highlightHtml(code.textContent ?? '', lang);
    if (colored !== null) code.innerHTML = colored;
  }

  const html = doc.body.innerHTML;
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(text, html);
  return html;
}
