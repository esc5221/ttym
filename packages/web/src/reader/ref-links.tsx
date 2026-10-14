import { sessionLinkHandler } from '@ttym/ui';
import { splitLinks, type LinkPart } from './links.js';

/**
 * Makes link-like text in the reader live: urls open in a new tab, `%1297` goes where the terminal's
 * own `%1297` goes (the handler the app registers with `setSessionLinkHandler`, which also draws the
 * hover preview). Text is split by `splitLinks`; this file draws the parts, as React for the person's
 * message and as DOM nodes for the agent's markdown, and one pair of delegated handlers on the page
 * serves every session reference, so the cached markdown HTML needs no handlers of its own.
 */

const SESSION_ATTR = 'data-session';
const HOST_ATTR = 'data-host';

/** `splitLinks` for what the app can act on now: with no handler registered a session reference is just text. */
function currentParts(text: string): LinkPart[] {
  const handler = sessionLinkHandler();
  const parts = splitLinks(text, handler?.hosts?.());
  return handler ? parts : parts.map((p) => (p.kind === 'session' ? { kind: 'text', text: p.text } : p));
}

export function Linkified({ text }: { text: string }) {
  const parts = currentParts(text);
  if (parts.length === 1 && parts[0].kind === 'text') return <>{text}</>;
  return (
    <>
      {parts.map((p, i) => p.kind === 'text' ? p.text
        : p.kind === 'url' ? <a key={i} href={p.href} target="_blank" rel="noreferrer noopener">{p.text}</a>
        : <span key={i} className="rd-ref" role="link" {...{ [SESSION_ATTR]: p.sessionId, [HOST_ATTR]: p.host }}>{p.text}</span>)}
    </>
  );
}

/** Links in the text nodes of rendered markdown. Existing links and code blocks are left as they are. */
export function linkifyTextNodes(doc: Document): void {
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  for (const node of nodes) {
    if (node.parentElement?.closest('a, pre')) continue;
    const parts = currentParts(node.data);
    if (parts.length === 1 && parts[0].kind === 'text') continue;
    const frag = doc.createDocumentFragment();
    for (const p of parts) {
      if (p.kind === 'text') { frag.append(doc.createTextNode(p.text)); continue; }
      const el = doc.createElement(p.kind === 'url' ? 'a' : 'span');
      el.textContent = p.text;
      if (p.kind === 'url') {
        el.setAttribute('href', p.href);
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noreferrer noopener');
      } else {
        el.className = 'rd-ref';
        el.setAttribute('role', 'link');
        el.setAttribute(SESSION_ATTR, String(p.sessionId));
        if (p.host) el.setAttribute(HOST_ATTR, p.host);
      }
      frag.append(el);
    }
    node.replaceWith(frag);
  }
}

function refAt(e: React.MouseEvent): { sessionId: number; host?: string } | null {
  const el = (e.target as Element | null)?.closest?.(`[${SESSION_ATTR}]`);
  if (!el) return null;
  return { sessionId: Number(el.getAttribute(SESSION_ATTR)), host: el.getAttribute(HOST_ATTR) ?? undefined };
}

/** Put on the element that holds the page's text. */
export const refLinkHandlers = {
  onClick(e: React.MouseEvent) {
    const ref = refAt(e);
    // A click that ends a text selection is not a click on the link.
    if (!ref || window.getSelection()?.isCollapsed === false) return;
    e.preventDefault();
    sessionLinkHandler()?.open(ref.sessionId, e.nativeEvent, ref.host);
  },
  onMouseOver(e: React.MouseEvent) {
    const ref = refAt(e);
    if (ref) sessionLinkHandler()?.hover?.(ref.sessionId, e.nativeEvent, ref.host);
  },
  onMouseOut(e: React.MouseEvent) {
    const ref = refAt(e);
    if (ref) sessionLinkHandler()?.leave?.(ref.sessionId, e.nativeEvent, ref.host);
  },
};
