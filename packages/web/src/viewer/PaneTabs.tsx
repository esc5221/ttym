import { useCallback, useEffect, useRef, useState } from 'react';
import type { ViewItem } from '@ttym/api';

/**
 * Viewer tabs in a pane header — one 30px line shared with the terminal's
 * name, its cwd, and the action cluster, in a pane that may be 400px wide.
 *
 * The rules, and why (Chrome's tab strip is the reference):
 *
 * - Tabs shrink before the strip scrolls. A header that scrolls its tabs
 *   away loses the one thing it is for — seeing what this pane has open.
 *   Width runs 160px → 60px; only past that does the strip scroll.
 * - The close button is a hazard on a narrow tab: aim for the label, hit
 *   the ×. Under 100px a tab shows × only when active or hovered.
 * - Closing with the mouse locks every tab's width until the pointer
 *   leaves the strip, so the next × lands where the last one was. Without
 *   this the survivors widen after each close and the target runs away.
 * - Middle click closes. Vertical wheel scrolls the strip sideways.
 */

const TAB_MAX = 160;
const TAB_MIN = 60;
const COMPACT_BELOW = 100;

export function PaneTabs({ items, activeId, onSelect, onClose, reserveRight = 8 }: {
  items: ViewItem[];
  activeId: string | null;
  onSelect: (vid: string) => void;
  onClose: (vid: string) => void;
  /** Pixels kept clear on the right for the header's always-visible action buttons (they are absolute). */
  reserveRight?: number;
}) {
  const stripRef = useRef<HTMLSpanElement | null>(null);
  const [compact, setCompact] = useState(false);
  const [fade, setFade] = useState({ left: false, right: false });
  /** Width every tab is pinned to while the user is closing tabs in a row. null = free. */
  const [locked, setLocked] = useState<number | null>(null);

  const measure = useCallback(() => {
    const el = stripRef.current;
    if (!el) return;
    const first = el.querySelector<HTMLElement>('.pane-tab');
    setCompact(first ? first.getBoundingClientRect().width < COMPACT_BELOW : false);
    const left = el.scrollLeft > 2;
    const right = el.scrollLeft < el.scrollWidth - el.clientWidth - 2;
    setFade((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);

  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, items.length]);

  // Keep the active tab in view when it changes (a new `ttym open` may land off-screen).
  useEffect(() => {
    const el = stripRef.current?.querySelector<HTMLElement>('.pane-tab.on');
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeId]);

  const close = (e: React.MouseEvent, vid: string) => {
    e.stopPropagation();
    e.preventDefault();
    // Lock widths to what they are now; released on mouseleave below.
    const first = stripRef.current?.querySelector<HTMLElement>('.pane-tab');
    if (first && locked === null) setLocked(first.getBoundingClientRect().width);
    onClose(vid);
  };

  return (
    <span className="pane-tabs" style={{ marginRight: reserveRight }} onDoubleClick={(e) => e.stopPropagation()}>
      <span
        ref={stripRef}
        className={`pane-tabs-scroll${compact ? ' compact' : ''}${fade.left ? ' fade-l' : ''}${fade.right ? ' fade-r' : ''}`}
        onMouseLeave={() => { if (locked !== null) { setLocked(null); requestAnimationFrame(measure); } }}
        onScroll={measure}
        onWheel={(e) => {
          const el = stripRef.current;
          if (!el || el.scrollWidth <= el.clientWidth) return;
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { el.scrollLeft += e.deltaY; e.preventDefault(); }
        }}
      >
        {items.map((item) => (
          <span
            key={item.id}
            className={`pane-tab${item.id === activeId ? ' on' : ''}`}
            style={locked !== null ? { flex: `0 0 ${locked}px`, width: locked } : { maxWidth: TAB_MAX, minWidth: TAB_MIN }}
            onClick={(e) => { e.stopPropagation(); onSelect(item.id); }}
            onAuxClick={(e) => { if (e.button === 1) close(e, item.id); }}
            title={item.target}
          >
            <span className="pane-tab-label">{item.name}</span>
            <button className="pane-tab-x" onClick={(e) => close(e, item.id)} title="close tab" tabIndex={-1}>×</button>
          </span>
        ))}
      </span>
    </span>
  );
}
