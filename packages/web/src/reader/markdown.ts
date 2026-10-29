import { highlightHtml, languageForTag } from '../viewer/highlight.js';
import { loadMarked } from './marked.js';
import { markMermaidBlocks } from './mermaid.js';
import { linkifyTextNodes } from './ref-links.js';

/**
 * The agent's words, as HTML. Same pipeline as the viewer's markdown tab
 * (marked → DOMPurify → highlight.js for fenced code), loaded on first use.
 *
 * Text arrives once and never changes, and the page re-renders often, so
 * results are kept by text (session references are linked as they were when the text was first rendered). A page of a long conversation would otherwise
 * parse every block again on each poll.
 */

/**
 * Kept by size, not count: one pane's long tool outputs used to push every other pane's blocks out of a
 * 400-entry cache shared by all of them. Least recently used goes first; a hit moves to the back.
 */
const CACHE_MAX_CHARS = 8_000_000;
const cache = new Map<string, string>();
let cacheChars = 0;

function cacheGet(text: string): string | undefined {
  const hit = cache.get(text);
  if (hit === undefined) return undefined;
  cache.delete(text);
  cache.set(text, hit);
  return hit;
}

function cachePut(text: string, html: string): void {
  const prev = cache.get(text);
  if (prev !== undefined) { cache.delete(text); cacheChars -= text.length + prev.length; }
  cache.set(text, html);
  cacheChars += text.length + html.length;
  for (const [k, v] of cache) {
    if (cacheChars <= CACHE_MAX_CHARS || k === text) break;
    cache.delete(k);
    cacheChars -= k.length + v.length;
  }
}

/** Code longer than this stays uncoloured: highlighting a long output held the main thread for seconds. */
export const HIGHLIGHT_MAX_LINES = 300;
export const HIGHLIGHT_MAX_CHARS = 20 * 1024;

export function cachedMarkdown(text: string): string | undefined {
  return cacheGet(text);
}

/**
 * `live`: the text is the unfinished end of a message that is still being written. It changes ten times a second, so it
 * is neither kept (the cache would fill with versions nobody asks for again) nor coloured or turned into diagrams
 * (half a code block or half a diagram is not worth the work, and would flicker); both happen when its block closes.
 */
type Libs = { marked: typeof import('marked')['marked']; purify: typeof import('dompurify')['default'] };
let libs: Libs | null = null;

/** Everything about turning text into the page's HTML except colouring code, so it can run at once when the libraries are loaded. */
function toDoc(text: string, { l, mermaid }: { l: Libs; mermaid: boolean }): Document {
  // Single newlines stay soft, as in the agent's own rendering; blank lines make paragraphs.
  const raw = l.marked.parse(text, { gfm: true, breaks: false }) as string;
  const clean = l.purify.sanitize(raw, { ADD_ATTR: ['target'] });
  const doc = new DOMParser().parseFromString(clean, 'text/html');
  for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noreferrer noopener');
  }
  if (mermaid) markMermaidBlocks(doc);
  return doc;
}

/**
 * The HTML for `text` if it can be had without waiting: kept, or rendered here and now once the libraries have
 * loaded (code uncoloured; the full render replaces it a moment later). A block that comes on the page already drawn
 * does not flash as plain text first, which matters when it takes the place of something that was just on screen.
 */
export function renderMarkdownNow(text: string): string | undefined {
  const hit = cacheGet(text);
  if (hit !== undefined) return hit;
  if (!libs) return undefined;
  try {
    const doc = toDoc(text, { l: libs, mermaid: true });
    linkifyTextNodes(doc);
    return doc.body.innerHTML;
  } catch { return undefined; }
}

/**
 * `live`: the text is the unfinished end of a message that is still being written. It changes several times a second, so it
 * is neither kept (the cache would fill with versions nobody asks for again) nor coloured or turned into diagrams
 * (half a code block or half a diagram is not worth the work, and would flicker); both happen when its block closes.
 */
export async function renderMarkdown(text: string, opts: { live?: boolean } = {}): Promise<string> {
  const live = opts.live === true;
  const hit = live ? undefined : cacheGet(text);
  if (hit !== undefined) return hit;

  if (!libs) {
    const [marked, { default: purify }] = await Promise.all([loadMarked(), import('dompurify')]);
    libs = { marked, purify };
  }
  const doc = toDoc(text, { l: libs, mermaid: !live });
  for (const code of live ? [] : Array.from(doc.querySelectorAll('pre > code'))) {
    const tag = Array.from(code.classList).find((c) => c.startsWith('language-'))?.slice('language-'.length) ?? '';
    const lang = languageForTag(tag);
    if (!lang) continue;
    const source = code.textContent ?? '';
    if (source.length > HIGHLIGHT_MAX_CHARS || source.split('\n', HIGHLIGHT_MAX_LINES + 2).length > HIGHLIGHT_MAX_LINES + 1) continue;
    // hljs escapes its own output, and the text it reads has already been sanitised.
    const colored = await highlightHtml(source, lang);
    if (colored !== null) code.innerHTML = colored;
  }

  linkifyTextNodes(doc);

  const html = doc.body.innerHTML;
  if (live) return html;
  cachePut(text, html);
  return html;
}
