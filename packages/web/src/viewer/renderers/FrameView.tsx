import type { ViewItem } from '@ttym/api';
import { viewSrc } from '../content.js';

/**
 * The browser renders it: HTML, PDF, a site directory, a URL.
 *
 * A local file runs sandboxed *without* allow-same-origin. Same origin
 * would hand the page our DOM, localStorage, /api and /ws — and a report an
 * agent just generated is not trusted code. A URL is somebody else's
 * origin already; there the sandbox keeps its own cookies and scripts so
 * the site actually works.
 */
export function FrameView({ item }: { item: ViewItem }) {
  const local = item.kind !== 'url';
  return (
    <iframe
      className="viewer-frame"
      src={viewSrc(item)}
      title={item.name}
      sandbox={local ? 'allow-scripts allow-forms allow-popups allow-downloads allow-modals' : 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals'}
      referrerPolicy="no-referrer"
    />
  );
}
