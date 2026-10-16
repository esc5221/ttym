import './mermaid.css';

/**
 * Mermaid diagrams in rendered markdown.
 *
 * `markdown.ts` leaves a fenced ```mermaid block as `<figure class="rd-mmd"><pre><code>source</code></pre></figure>`,
 * which is already a readable fallback. `hydrateMermaid` turns the figures under a node into drawings once the
 * (large) library has loaded; a diagram that does not parse stays as its source with the error under it.
 *
 * The library is loaded on first use and renders one diagram at a time (it keeps global state between calls).
 * Drawings are kept by source and theme so a page that re-renders does not draw them again.
 */

type Mermaid = typeof import('mermaid').default;

export type MermaidResult =
  | { ok: true; svg: string; width: number; height: number }
  | { ok: false; error: string };

export type MermaidTheme = 'light' | 'dark';

export const FIGURE_CLASS = 'rd-mmd';

let library: Promise<Mermaid> | undefined;
const loadMermaid = (): Promise<Mermaid> => (library ??= import('mermaid').then((m) => m.default));

const CACHE_MAX = 60;
const drawn = new Map<string, MermaidResult>();
let queue: Promise<unknown> = Promise.resolve();
let seq = 0;

export const currentTheme = (): MermaidTheme => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

/** mermaid's colour maths cannot read `var(--x)`, so the page's tokens are read here as the literal colours they are. */
function themeVariables(theme: MermaidTheme, font: string): Record<string, string | boolean> {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const bg0 = v('--bg0', theme === 'dark' ? '#1e1e1e' : '#f5f5f5');
  const bg1 = v('--bg1', theme === 'dark' ? '#252525' : '#ffffff');
  const bg2 = v('--bg2', theme === 'dark' ? '#2d2d2d' : '#ececec');
  const text = v('--text', theme === 'dark' ? '#dddddd' : '#24292f');
  const soft = v('--text-soft', '#888888');
  const strong = v('--line-strong', '#666666');
  return {
    darkMode: theme === 'dark',
    background: bg1,
    fontFamily: font,
    fontSize: '14px',
    primaryColor: bg2,
    primaryTextColor: text,
    primaryBorderColor: strong,
    secondaryColor: bg1,
    secondaryTextColor: text,
    tertiaryColor: bg0,
    tertiaryTextColor: text,
    lineColor: soft,
    textColor: text,
    mainBkg: bg2,
    nodeBorder: strong,
    clusterBkg: bg1,
    clusterBorder: strong,
    edgeLabelBackground: bg0,
    titleColor: text,
    noteBkgColor: bg1,
    noteTextColor: text,
    noteBorderColor: strong,
    // The default glow is a light-grey blur meant for a white page; on a dark one it reads as a white halo.
    dropShadow: 'none',
  };
}

/** The drawing at its natural size: mermaid sizes it to the width it was drawn in, which squeezes a wide diagram until its text is unreadable. */
function atNaturalSize(svg: string): { svg: string; width: number; height: number } | null {
  // The markup holds HTML labels that are not well-formed XML (`<br>`, `&nbsp;`), so only the opening tag is read and rewritten.
  const open = /<svg\b[^>]*>/.exec(svg);
  if (!open) return null;
  const box = /\bviewBox="([^"]*)"/.exec(open[0])?.[1]?.split(/[\s,]+/).map(Number) ?? [];
  const [width, height] = [box[2], box[3]];
  if (!(width > 0) || !(height > 0)) return null;
  const tag = open[0]
    .replace(/\s(?:width|height|style)="[^"]*"/g, '')
    .replace(/^<svg\b/, `<svg width="${Math.ceil(width)}" height="${Math.ceil(height)}"`);
  return { svg: tag + svg.slice(open.index + open[0].length), width, height };
}

export function renderMermaid(source: string, theme: MermaidTheme, font: string): Promise<MermaidResult> {
  const key = `${theme}\u0000${font}\u0000${source}`;
  const hit = drawn.get(key);
  if (hit) return Promise.resolve(hit);

  const job = queue.then(async (): Promise<MermaidResult> => {
    const mermaid = await loadMermaid();
    const id = `ttym-mmd-${++seq}`;
    let result: MermaidResult;
    try {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'base',
        themeVariables: themeVariables(theme, font),
        flowchart: { useMaxWidth: false, htmlLabels: true },
        sequence: { useMaxWidth: false },
        gantt: { useMaxWidth: false },
        er: { useMaxWidth: false },
        journey: { useMaxWidth: false },
        class: { useMaxWidth: false },
        state: { useMaxWidth: false },
      });
      const out = await mermaid.render(id, source);
      const sized = atNaturalSize(out.svg);
      result = sized ? { ok: true, ...sized } : { ok: false, error: 'The drawing came back without a size.' };
    } catch (e) {
      result = { ok: false, error: String((e as Error)?.message ?? e).split('\n').slice(0, 3).join('\n') };
    }
    // A diagram that fails to parse leaves its error drawing (and the measuring box) in the document.
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
    if (drawn.size >= CACHE_MAX) drawn.delete(drawn.keys().next().value as string);
    drawn.set(key, result);
    return result;
  });
  queue = job.catch(() => undefined);
  return job;
}

/** Wraps each fenced mermaid block in the figure `hydrateMermaid` looks for; the block stays inside as the fallback. */
export function markMermaidBlocks(doc: Document): void {
  for (const code of Array.from(doc.querySelectorAll('pre > code.language-mermaid'))) {
    const pre = code.parentElement;
    if (!pre) continue;
    const fig = doc.createElement('figure');
    fig.className = FIGURE_CLASS;
    pre.replaceWith(fig);
    fig.appendChild(pre);
  }
}

// ───── figures ─────

/** A diagram is fitted to the column; this is how small it may get before the rest is left to "Expand" (a clipped diagram looks like a broken one). */
const MIN_SCALE = 0.3;

const button = (label: string, title: string, onClick: () => void): HTMLButtonElement => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'rd-mmd-btn';
  b.textContent = label;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return b;
};

function copy(text: string, done: (ok: boolean) => void): void {
  navigator.clipboard?.writeText(text).then(() => done(true), () => done(false)) ?? done(false);
}

function showFallback(fig: HTMLElement, source: string, error?: string): void {
  fig.dataset.state = error ? 'error' : 'loading';
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.className = 'language-mermaid';
  code.textContent = source;
  pre.appendChild(code);
  fig.replaceChildren(pre);
  if (error) {
    const note = document.createElement('div');
    note.className = 'rd-mmd-err';
    note.textContent = `Diagram can’t be drawn: ${error}`;
    fig.appendChild(note);
  }
}

function showDrawing(fig: HTMLElement, source: string, drawing: Extract<MermaidResult, { ok: true }>): void {
  fig.dataset.state = 'done';
  const holder = document.createElement('div');
  holder.className = 'rd-mmd-svg';
  holder.innerHTML = drawing.svg;
  const svg = holder.querySelector('svg');
  holder.title = 'Click to open larger';
  holder.addEventListener('click', () => openZoom(drawing.svg, drawing.width, drawing.height));

  const bar = document.createElement('div');
  bar.className = 'rd-mmd-bar';
  const src = document.createElement('pre');
  src.className = 'rd-mmd-src';
  src.hidden = true;
  src.textContent = source;
  const copyBtn = button('Copy', 'Copy the diagram source', () => copy(source, (ok) => {
    copyBtn.textContent = ok ? 'Copied' : 'Failed';
    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
  }));
  const srcBtn = button('Source', 'Show the diagram source', () => {
    src.hidden = !src.hidden;
    srcBtn.setAttribute('aria-pressed', String(!src.hidden));
  });
  bar.append(button('Expand', 'Open larger, with zoom', () => openZoom(drawing.svg, drawing.width, drawing.height)), srcBtn, copyBtn);

  fig.replaceChildren(bar, holder, src);
  if (svg) {
    // The width it fits to is the column's, which is not known until the figure is laid out and changes with the window and the pane, so it is refitted on every resize.
    const fit = () => {
      const room = holder.clientWidth - 24;
      if (room <= 0) return;
      const scale = Math.max(MIN_SCALE, Math.min(1, room / drawing.width));
      svg.setAttribute('width', String(Math.round(drawing.width * scale)));
      svg.setAttribute('height', String(Math.round(drawing.height * scale)));
    };
    fit();
    const watcher = new ResizeObserver(() => { if (holder.isConnected) fit(); else watcher.disconnect(); });
    watcher.observe(holder);
  }
}

/**
 * Draws every mermaid figure under `root`. Returns a function that stops late results from being written
 * (the node was replaced or the page left).
 */
export function hydrateMermaid(root: HTMLElement): () => void {
  let live = true;
  const figures = Array.from(root.querySelectorAll<HTMLElement>(`figure.${FIGURE_CLASS}`));
  if (figures.length === 0) return () => {};
  const theme = currentTheme();
  const font = getComputedStyle(root).fontFamily;
  for (const fig of figures) {
    const source = fig.dataset.src ?? fig.querySelector('code')?.textContent ?? '';
    fig.dataset.src = source;
    if (fig.dataset.state === undefined) showFallback(fig, source);
    void renderMermaid(source, theme, font).then((r) => {
      if (!live || !fig.isConnected) return;
      if (r.ok) showDrawing(fig, source, r); else showFallback(fig, source, r.error);
    });
  }
  return () => { live = false; };
}

// ───── zoom ─────

function openZoom(svgMarkup: string, width: number, height: number): void {
  const overlay = document.createElement('div');
  overlay.className = 'rd-mmd-zoom';
  const stage = document.createElement('div');
  stage.className = 'rd-mmd-zoom-stage';
  stage.innerHTML = svgMarkup;
  const svg = stage.querySelector('svg');
  if (!svg) return;
  svg.style.cssText = 'display:block;max-width:none;transform-origin:0 0;position:absolute;left:0;top:0';

  let scale = 1;
  let x = 0;
  let y = 0;
  const apply = () => { svg.style.transform = `translate(${x}px, ${y}px) scale(${scale})`; };
  const fit = () => {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    scale = Math.min(w / width, h / height, 2) * 0.96;
    x = (w - width * scale) / 2;
    y = (h - height * scale) / 2;
    apply();
  };
  const zoomAt = (cx: number, cy: number, factor: number) => {
    const next = Math.min(8, Math.max(0.1, scale * factor));
    const k = next / scale;
    x = cx - (cx - x) * k;
    y = cy - (cy - y) * k;
    scale = next;
    apply();
  };
  const center = () => { const r = stage.getBoundingClientRect(); return [r.width / 2, r.height / 2] as const; };

  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };

  const bar = document.createElement('div');
  bar.className = 'rd-mmd-zoom-bar';
  bar.append(
    button('+', 'Zoom in', () => zoomAt(...center(), 1.25)),
    button('−', 'Zoom out', () => zoomAt(...center(), 0.8)),
    button('Fit', 'Fit to window', fit),
    button('100%', 'Actual size', () => { const [cx, cy] = center(); zoomAt(cx, cy, 1 / scale); }),
    button('Close', 'Close', close),
  );

  // Pan with one pointer, pinch with two, zoom with the wheel.
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch = 0;
  stage.addEventListener('pointerdown', (e) => { stage.setPointerCapture(e.pointerId); pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); pinch = 0; });
  stage.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) { x += e.clientX - prev.x; y += e.clientY - prev.y; apply(); return; }
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
    if (pinch > 0 && d > 0) {
      const r = stage.getBoundingClientRect();
      zoomAt((a!.x + b!.x) / 2 - r.left, (a!.y + b!.y) / 2 - r.top, d / pinch);
    }
    pinch = d;
  });
  const lift = (e: PointerEvent) => { pointers.delete(e.pointerId); pinch = 0; };
  stage.addEventListener('pointerup', lift);
  stage.addEventListener('pointercancel', lift);
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)));
  }, { passive: false });

  overlay.append(bar, stage);
  document.body.appendChild(overlay);
  document.addEventListener('keydown', onKey, true);
  fit();
}
