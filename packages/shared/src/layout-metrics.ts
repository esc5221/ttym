import type { LayoutNode } from './workspace-domain.js';

/**
 * 이 폭(px)에 그렸을 때 가장 좁은 pane의 폭.
 *
 * 레이아웃은 비율로 저장되고 브라우저가 창 폭에 투영한다(LayoutView). 12칸이 한 줄이면
 * 칸당 폭이 창 폭의 1/12가 되는데 렌더에는 하한이 없다 — minPanePx는 divider를 끌 때만
 * 걸린다. 그래서 "지금 칸이 너무 좁은가"를 비율 트리에서 직접 계산한다.
 *
 * col 분할은 폭을 나누지 않고, row 분할은 sizes 비율로 나눈다. splitterPx는 분할선 한 개의 두께.
 */
export function narrowestPanePx(node: LayoutNode, widthPx: number, splitterPx = 0): number {
  if (node.type === 'pane') return widthPx;
  const count = node.children.length;
  if (count === 0) return widthPx;
  if (node.axis === 'col') {
    return Math.min(...node.children.map((child) => narrowestPanePx(child, widthPx, splitterPx)));
  }
  const total = node.sizes.length === count ? node.sizes.reduce((a, b) => a + b, 0) : 0;
  const usable = Math.max(0, widthPx - splitterPx * (count - 1));
  return Math.min(...node.children.map((child, i) => {
    const share = total > 0 ? node.sizes[i]! / total : 1 / count;
    return narrowestPanePx(child, usable * share, splitterPx);
  }));
}
