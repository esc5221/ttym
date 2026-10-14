import { matchSessionRefs } from '@ttym/shared';

/**
 * Which stretches of a piece of text are links, and what kind.
 *
 * One tokenizer for everything the reader prints as text: the markdown pass over the agent's
 * words (DOM text nodes) and the person's own message (React). Each draws the parts its own way.
 * A session reference (`%1297`, `box%78`) follows the same rule as in the terminal, `matchSessionRefs`.
 */

export type LinkPart =
  | { kind: 'text'; text: string }
  | { kind: 'url'; text: string; href: string }
  | { kind: 'session'; text: string; sessionId: number; host?: string };

// ASCII only, so a URL followed directly by Korean text ends where the Korean starts.
const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&()*+,;=%]+/g;
const TRAILING = /[.,;:!?]+$/;

/** A URL written in a sentence: drop the punctuation that belongs to the sentence, and a closing bracket nothing opened. */
function trimUrl(raw: string): string {
  let url = raw.replace(TRAILING, '');
  for (;;) {
    const last = url[url.length - 1];
    const open = last === ')' ? '(' : last === ']' ? '[' : null;
    if (!open) break;
    const opens = url.split(open).length - 1;
    const closes = url.split(last).length - 1;
    if (closes <= opens) break;
    url = url.slice(0, -1).replace(TRAILING, '');
  }
  return url;
}

export function splitLinks(text: string, hosts?: ReadonlySet<string>): LinkPart[] {
  type Hit = { start: number; end: number; part: LinkPart };
  const hits: Hit[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const url = trimUrl(m[0]);
    try { new URL(url); } catch { continue; }
    hits.push({ start: m.index!, end: m.index! + url.length, part: { kind: 'url', text: url, href: url } });
  }
  for (const r of matchSessionRefs(text, hosts)) {
    hits.push({ start: r.start, end: r.end, part: { kind: 'session', text: text.slice(r.start, r.end), sessionId: r.sessionId, host: r.host } });
  }
  hits.sort((a, b) => a.start - b.start);

  const out: LinkPart[] = [];
  let at = 0;
  for (const h of hits) {
    if (h.start < at) continue; // inside the previous link: the URL wins
    if (h.start > at) out.push({ kind: 'text', text: text.slice(at, h.start) });
    out.push(h.part);
    at = h.end;
  }
  if (at < text.length) out.push({ kind: 'text', text: text.slice(at) });
  return out;
}
