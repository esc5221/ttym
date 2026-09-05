import { useEffect, useRef, useState } from 'react';
import type { ViewItem } from '@ttym/api';
import { viewSrc } from '../content.js';
import { useScrollMemory } from '../useScrollMemory.js';

/**
 * PDF, drawn by PDF.js inside the app.
 *
 * Not an <iframe>: Chrome renders PDFs with a plugin, and a sandboxed frame
 * disables plugins — the tab came up blank. Dropping the sandbox would fix
 * Chrome and still leave iOS Safari showing page one only. Drawing the
 * pages ourselves is the same everywhere and keeps the viewer's chrome.
 *
 * Only pages near the viewport are rendered (and released when far away),
 * so a 400-page manual costs a few canvases. A text layer sits over each
 * page for selection, search and copy. PDF.js loads on the first PDF tab.
 */

type Pdfjs = typeof import('pdfjs-dist');
type PdfDoc = import('pdfjs-dist').PDFDocumentProxy;

let lib: Promise<Pdfjs> | null = null;
function pdfjs(): Promise<Pdfjs> {
  if (!lib) {
    lib = import('pdfjs-dist').then((m) => {
      // ?v= is a cache key, not decoration: the first deploy served .mjs as
      // octet-stream under a one-year Cache-Control, and browsers keep that.
      m.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString() + `?v=${m.version}`;
      return m;
    });
  }
  return lib;
}

const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

export function PdfView({ item }: { item: ViewItem }) {
  const scrollRef = useScrollMemory(item.cap ?? item.id);
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageSizes, setPageSizes] = useState<Array<{ w: number; h: number }>>([]);
  const [zoom, setZoom] = useState<'fit' | number>(() => { try { return JSON.parse(localStorage.getItem('ttym-viewer-pdf-zoom') ?? '"fit"'); } catch { return 'fit'; } });
  const [containerW, setContainerW] = useState(0);
  const [current, setCurrent] = useState(1);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let task: { destroy: () => Promise<void> } | null = null;
    (async () => {
      try {
        const m = await pdfjs();
        const loading = m.getDocument({ url: viewSrc(item), withCredentials: false });
        task = loading;
        const d = await loading.promise;
        if (cancelled) return;
        const sizes: Array<{ w: number; h: number }> = [];
        // Page sizes up front, so the scroll height is right before any page is drawn.
        for (let i = 1; i <= d.numPages; i++) {
          const page = await d.getPage(i);
          const vp = page.getViewport({ scale: 1 });
          sizes.push({ w: vp.width, h: vp.height });
          if (cancelled) return;
        }
        setPageSizes(sizes);
        setDoc(d);
      } catch (e) {
        if (!cancelled) setError(String((e as Error).message ?? e));
      }
    })();
    return () => { cancelled = true; void task?.destroy(); };
  }, [item.cap, item.rev]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContainerW(el.clientWidth));
    ro.observe(el);
    setContainerW(el.clientWidth);
    return () => ro.disconnect();
  }, [doc]);

  useEffect(() => { try { localStorage.setItem('ttym-viewer-pdf-zoom', JSON.stringify(zoom)); } catch {} }, [zoom]);

  if (error) return <div className="viewer-empty viewer-error">{error}</div>;
  if (!doc) return <div className="viewer-empty">loading…</div>;

  const pad = 16;
  const maxW = Math.max(...pageSizes.map((s) => s.w), 1);
  const fitScale = Math.max(0.2, (containerW - pad * 2) / maxW);
  const scale = zoom === 'fit' ? fitScale : zoom;
  const stepZoom = (dir: -1 | 1) => setZoom((z) => {
    const cur = z === 'fit' ? fitScale : z;
    const next = dir > 0 ? ZOOM_STEPS.find((s) => s > cur + 0.01) : [...ZOOM_STEPS].reverse().find((s) => s < cur - 0.01);
    return next ?? cur;
  });

  return (
    <div className="viewer-scroll viewer-pdf" ref={(el) => { scrollRef(el); containerRef.current = el; }}
      onScroll={(e) => {
        // Which page is under the middle of the view — for the counter.
        const el = e.currentTarget;
        const mid = el.scrollTop + el.clientHeight / 2;
        let y = pad;
        for (let i = 0; i < pageSizes.length; i++) {
          const h = pageSizes[i]!.h * scale + pad;
          if (mid < y + h) { setCurrent(i + 1); break; }
          y += h;
        }
      }}
    >
      <div className="viewer-note viewer-pdf-bar">
        <span>{current} / {doc.numPages}</span>
        <span className="viewer-pdf-zoom">
          <button className="viewer-note-btn" onClick={() => stepZoom(-1)} title="zoom out">−</button>
          <button className="viewer-note-btn" onClick={() => setZoom('fit')} title="fit width" style={zoom === 'fit' ? { color: 'var(--accent)' } : undefined}>{Math.round(scale * 100)}%</button>
          <button className="viewer-note-btn" onClick={() => stepZoom(1)} title="zoom in">+</button>
        </span>
      </div>
      <div className="viewer-pdf-pages" style={{ padding: pad, gap: pad }}>
        {pageSizes.map((size, i) => (
          <PdfPage key={i} doc={doc} index={i + 1} width={size.w * scale} height={size.h * scale} scale={scale} />
        ))}
      </div>
    </div>
  );
}

/** One page: a placeholder of the right size until it nears the viewport, then canvas + text layer; released again when far. */
function PdfPage({ doc, index, width, height, scale }: { doc: PdfDoc; index: number; width: number; height: number; scale: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setNear(!!entry?.isIntersecting), { rootMargin: '1200px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || !near) return;
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    (async () => {
      const m = await pdfjs();
      const page = await doc.getPage(index);
      if (cancelled) return;
      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const render = page.render({ canvasContext: ctx, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined } as Parameters<typeof page.render>[0]);
      task = render;
      try { await render.promise; } catch { return; }
      if (cancelled) return;
      const textDiv = document.createElement('div');
      textDiv.className = 'textLayer';
      textDiv.style.width = `${viewport.width}px`;
      textDiv.style.height = `${viewport.height}px`;
      el.replaceChildren(canvas, textDiv);
      try {
        const layer = new m.TextLayer({ textContentSource: page.streamTextContent(), container: textDiv, viewport });
        await layer.render();
      } catch { /* selection is a nicety; the page is already visible */ }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
      el.replaceChildren();
    };
  }, [doc, index, scale, near]);

  return <div ref={ref} className="viewer-pdf-page" style={{ width, height }} />;
}
