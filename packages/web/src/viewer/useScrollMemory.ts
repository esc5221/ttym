import { useCallback, useRef } from 'react';

/**
 * Remember where a scrolling view was, per tab, across reloads.
 *
 * The key is the tab's capability — stable for the tab's life, unlike the
 * element, which is recreated on every reload and rev bump. Restored the
 * moment the element mounts, which for every renderer here is after its
 * content is in the DOM; saved on scroll, cheaply.
 *
 * Frames are out of reach: a sandboxed cross-origin document keeps its own
 * scroll and tells us nothing.
 */
export function useScrollMemory(key: string): (el: HTMLElement | null) => void {
  const cleanup = useRef<(() => void) | null>(null);
  return useCallback((el: HTMLElement | null) => {
    cleanup.current?.();
    cleanup.current = null;
    if (!el) return;
    const storageKey = `ttym-viewer-scroll:${key}`;
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (saved) {
        const [top, left] = saved.split(',').map(Number);
        // Images and fonts still settle after mount; apply once now and once after a frame.
        el.scrollTop = top || 0; el.scrollLeft = left || 0;
        requestAnimationFrame(() => { el.scrollTop = top || 0; el.scrollLeft = left || 0; });
      }
    } catch {}
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        try { window.localStorage.setItem(storageKey, `${Math.round(el.scrollTop)},${Math.round(el.scrollLeft)}`); } catch {}
      }, 150);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    cleanup.current = () => { el.removeEventListener('scroll', onScroll); if (timer) clearTimeout(timer); };
  }, [key]);
}
