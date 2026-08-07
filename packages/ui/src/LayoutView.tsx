import { useEffect, useRef, useState, type ReactNode, type CSSProperties } from 'react';
import type { LayoutNode } from '@ttym/shared';

export interface LayoutViewProps {
  layout: LayoutNode;
  renderPane: (sessionId: number, path: number[]) => ReactNode;
  /** Commit new ratios for the split at `path` (pointer-up, not per-frame). */
  onResize?: (path: number[], sizes: number[]) => void;
  /** Client-local zoom: render just this pane at full size. Tree untouched. */
  zoomedSessionId?: number | null;
  /** Smallest a pane may be dragged to, in px of the split axis. */
  minPanePx?: number;
  splitterPx?: number;
  splitterColor?: string;
  splitterActiveColor?: string;
}

interface DragOverride {
  pathKey: string;
  sizes: number[];
}

function pathKeyOf(path: number[]): string {
  return path.join('.');
}

function findPane(node: LayoutNode, sessionId: number): boolean {
  if (node.type === 'pane') return node.sessionId === sessionId;
  return node.children.some((child) => findPane(child, sessionId));
}

/**
 * Renders the server's layout tree as it is — nested splits, stored ratios —
 * with draggable dividers. The tree is the truth: this component never
 * flattens it, and mutations leave through `onResize` as a ratio update for
 * one split node. Ratios stay the stored form because every viewer has a
 * different viewport; the browser projects them to pixels per client.
 */
export function LayoutView({
  layout,
  renderPane,
  onResize,
  zoomedSessionId = null,
  minPanePx = 90,
  splitterPx = 5,
  splitterColor = 'rgba(148,170,200,.16)',
  splitterActiveColor = '#6ea8ff',
}: LayoutViewProps) {
  const [drag, setDrag] = useState<DragOverride | null>(null);
  const dragRef = useRef<DragOverride | null>(null);
  dragRef.current = drag;

  // A committed drag survives visually until the server round-trip delivers
  // the tree that contains it; dropping it earlier would snap the divider
  // back for a frame.
  useEffect(() => { setDrag(null); }, [layout]);

  if (zoomedSessionId !== null && findPane(layout, zoomedSessionId)) {
    return <div style={{ width: '100%', height: '100%' }}>{renderPane(zoomedSessionId, [])}</div>;
  }

  const renderNode = (node: LayoutNode, path: number[]): ReactNode => {
    if (node.type === 'pane') {
      return renderPane(node.sessionId, path);
    }

    const key = pathKeyOf(path);
    const sizes = drag?.pathKey === key ? drag.sizes : normalize(node.sizes, node.children.length);
    const horizontal = node.axis === 'row';

    const startDrag = (index: number, e: React.PointerEvent<HTMLDivElement>) => {
      if (!onResize) return;
      e.preventDefault();
      const container = (e.currentTarget.parentElement as HTMLElement);
      const rect = container.getBoundingClientRect();
      const totalPx = horizontal ? rect.width : rect.height;
      if (totalPx <= 0) return;
      const startPos = horizontal ? e.clientX : e.clientY;
      const startSizes = sizes.slice();
      const minShare = Math.min(0.45, minPanePx / totalPx);

      const move = (ev: PointerEvent) => {
        const delta = ((horizontal ? ev.clientX : ev.clientY) - startPos) / totalPx;
        const next = startSizes.slice();
        // Only the pair around the divider moves — siblings keep their share,
        // which is what keeps a drag from rippling across the whole split.
        const grow = Math.max(minShare, Math.min(startSizes[index] + startSizes[index + 1] - minShare, startSizes[index] + delta));
        next[index] = grow;
        next[index + 1] = startSizes[index] + startSizes[index + 1] - grow;
        setDrag({ pathKey: key, sizes: next });
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        const committed = dragRef.current;
        if (committed && committed.pathKey === key) onResize(path, committed.sizes);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    };

    const children: ReactNode[] = [];
    node.children.forEach((child, i) => {
      children.push(
        <div
          key={`c${i}`}
          style={{
            flexBasis: `${sizes[i] * 100}%`,
            flexGrow: 0,
            flexShrink: 1,
            minWidth: 0,
            minHeight: 0,
            display: 'flex',
            overflow: 'hidden',
          }}
        >
          {renderNode(child, [...path, i])}
        </div>,
      );
      if (i < node.children.length - 1) {
        children.push(
          <Splitter
            key={`s${i}`}
            horizontal={horizontal}
            px={splitterPx}
            color={splitterColor}
            activeColor={splitterActiveColor}
            onPointerDown={(e) => startDrag(i, e)}
          />,
        );
      }
    });

    const style: CSSProperties = {
      display: 'flex',
      flexDirection: horizontal ? 'row' : 'column',
      width: '100%',
      height: '100%',
      minWidth: 0,
      minHeight: 0,
    };
    return <div style={style}>{children}</div>;
  };

  return <div style={{ width: '100%', height: '100%' }}>{renderNode(layout, [])}</div>;
}

function normalize(sizes: number[] | undefined, count: number): number[] {
  const list = Array.isArray(sizes) && sizes.length === count ? sizes.slice() : Array(count).fill(1 / count);
  const sum = list.reduce((a, v) => a + (Number.isFinite(v) && v > 0 ? v : 0), 0);
  if (sum <= 0) return Array(count).fill(1 / count);
  return list.map((v) => (Number.isFinite(v) && v > 0 ? v / sum : 0));
}

function Splitter({ horizontal, px, color, activeColor, onPointerDown }: {
  horizontal: boolean;
  px: number;
  color: string;
  activeColor: string;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
}) {
  const [hot, setHot] = useState(false);
  return (
    <div
      onPointerDown={(e) => { setHot(true); onPointerDown(e); const clear = () => { setHot(false); window.removeEventListener('pointerup', clear); }; window.addEventListener('pointerup', clear); }}
      onMouseEnter={() => setHot(true)}
      onMouseLeave={() => setHot(false)}
      style={{
        flexShrink: 0,
        width: horizontal ? px : '100%',
        height: horizontal ? '100%' : px,
        cursor: horizontal ? 'col-resize' : 'row-resize',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 5,
      }}
    >
      <div
        style={{
          width: horizontal ? 3 : 34,
          height: horizontal ? 34 : 3,
          borderRadius: 2,
          background: hot ? activeColor : color,
        }}
      />
    </div>
  );
}
