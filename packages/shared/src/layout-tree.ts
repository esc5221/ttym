import type { LayoutNode, PaneNode, SplitNode } from './workspace-domain.js';

/**
 * Layout mutations that rewrite only the target node and its ancestors.
 *
 * The previous implementation flattened the tree to a list of session ids and
 * rebuilt it, which always produced a single row split with equal sizes. Every
 * nesting level and every ratio the user had set was lost on each add or
 * remove — all seven production workspaces ended up flat and evenly divided.
 *
 * The contract here is the opposite: sibling subtrees and their sizes come out
 * of these functions exactly as they went in.
 */

const EMPTY_PANE: PaneNode = { type: 'pane', sessionId: 0 };

function isPane(node: LayoutNode): node is PaneNode {
  return node.type === 'pane';
}

/** Session ids in left-to-right order, skipping the placeholder pane. */
export function layoutSessionIds(node: LayoutNode): number[] {
  if (isPane(node)) return node.sessionId > 0 ? [node.sessionId] : [];
  return node.children.flatMap(layoutSessionIds);
}

export function layoutHasSession(node: LayoutNode, sessionId: number): boolean {
  if (isPane(node)) return node.sessionId === sessionId;
  return node.children.some((child) => layoutHasSession(child, sessionId));
}

/**
 * Scale `sizes` so they sum to 1 while keeping their ratios to each other.
 * An all-zero or empty input falls back to an even split, which is the only
 * defensible answer when there is no ratio to preserve.
 */
function normalize(sizes: number[]): number[] {
  if (sizes.length === 0) return [];
  const clean = sizes.map((s) => (Number.isFinite(s) && s > 0 ? s : 0));
  const total = clean.reduce((a, b) => a + b, 0);
  if (total <= 0) return clean.map(() => 1 / clean.length);
  return clean.map((s) => s / total);
}

/** A split's sizes must line up with its children; repair rather than trust. */
function alignSizes(sizes: number[] | undefined, count: number): number[] {
  const given = Array.isArray(sizes) ? sizes.slice(0, count) : [];
  while (given.length < count) given.push(1 / Math.max(count, 1));
  return normalize(given);
}

function split(axis: 'row' | 'col', children: LayoutNode[], sizes: number[]): SplitNode {
  return { type: 'split', axis, children, sizes: alignSizes(sizes, children.length) };
}

/**
 * Add a pane without saying where.
 *
 * It goes at the end of the root split, and the existing children keep their
 * ratios to each other — [0.7, 0.3] becomes [0.47, 0.2, 0.33], not [⅓, ⅓, ⅓].
 * A root that is a single pane becomes a two-way split.
 */
export function insertPane(root: LayoutNode, sessionId: number, axis: 'row' | 'col' = 'row'): LayoutNode {
  if (sessionId <= 0) return root;
  if (layoutHasSession(root, sessionId)) return root;

  if (isPane(root)) {
    // The placeholder pane is a slot, not a sibling: fill it.
    if (root.sessionId <= 0) return { type: 'pane', sessionId };
    return split(axis, [root, { type: 'pane', sessionId }], [0.5, 0.5]);
  }

  const count = root.children.length;
  const existing = alignSizes(root.sizes, count);
  const share = 1 / (count + 1);
  const scaled = existing.map((s) => s * (1 - share));
  return {
    ...root,
    children: [...root.children, { type: 'pane', sessionId }],
    sizes: normalize([...scaled, share]),
  };
}

/**
 * Split `targetSessionId`'s pane in two and put the new session beside it.
 *
 * Only that pane is replaced. Its slot in the parent keeps the same size, so
 * the rest of the layout does not move — which is what makes this a split
 * rather than a rebuild.
 */
export function splitPane(
  root: LayoutNode,
  targetSessionId: number,
  sessionId: number,
  axis: 'row' | 'col' = 'row',
  ratio = 0.5,
  before = false,
): LayoutNode {
  if (sessionId <= 0) return root;
  if (layoutHasSession(root, sessionId)) return root;
  if (!layoutHasSession(root, targetSessionId)) return insertPane(root, sessionId, axis);

  const bounded = Math.min(Math.max(ratio, 0.05), 0.95);

  const rewrite = (node: LayoutNode): LayoutNode => {
    if (isPane(node)) {
      if (node.sessionId !== targetSessionId) return node;
      const fresh: LayoutNode = { type: 'pane', sessionId };
      return before
        ? split(axis, [fresh, node], [bounded, 1 - bounded])
        : split(axis, [node, fresh], [1 - bounded, bounded]);
    }
    if (!layoutHasSession(node, targetSessionId)) return node; // sibling: untouched

    // Splitting along this split's own axis joins the row instead of nesting:
    // a 50/50 row split again reads as thirds, not 50/25/25. Every sibling
    // gives up a proportional share, so hand-dragged ratios keep their
    // relations. Nesting is reserved for the cross axis, where it means it.
    const targetIndex = node.axis === axis
      ? node.children.findIndex((child) => isPane(child) && child.sessionId === targetSessionId)
      : -1;
    if (targetIndex !== -1) {
      const count = node.children.length;
      const share = 1 / (count + 1);
      const scaled = alignSizes(node.sizes, count).map((size) => size * (1 - share));
      const at = before ? targetIndex : targetIndex + 1;
      const children = node.children.slice();
      children.splice(at, 0, { type: 'pane', sessionId });
      const sizes = scaled.slice();
      sizes.splice(at, 0, share);
      return { ...node, children, sizes: normalize(sizes) };
    }

    return { ...node, children: node.children.map(rewrite), sizes: alignSizes(node.sizes, node.children.length) };
  };

  return rewrite(root);
}

/**
 * Remove a pane. Its size is dropped and the remaining siblings keep their
 * ratios. A split left with one child collapses into that child, so removing
 * back down to a single pane does not leave an empty wrapper behind.
 */
export function removePane(root: LayoutNode, sessionId: number): LayoutNode {
  if (!layoutHasSession(root, sessionId)) return root;

  const rewrite = (node: LayoutNode): LayoutNode | null => {
    if (isPane(node)) return node.sessionId === sessionId ? null : node;
    if (!layoutHasSession(node, sessionId)) return node; // sibling: untouched

    const sizes = alignSizes(node.sizes, node.children.length);
    const kept: LayoutNode[] = [];
    const keptSizes: number[] = [];
    node.children.forEach((child, i) => {
      const next = rewrite(child);
      if (next === null) return;
      kept.push(next);
      keptSizes.push(sizes[i]);
    });

    if (kept.length === 0) return null;
    if (kept.length === 1) return kept[0]; // collapse the now-pointless split
    return { ...node, children: kept, sizes: normalize(keptSizes) };
  };

  return rewrite(root) ?? EMPTY_PANE;
}

/** Replace one split's sizes, leaving every node identity intact elsewhere. */
export function resizeSplit(root: LayoutNode, path: number[], sizes: number[]): LayoutNode {
  const rewrite = (node: LayoutNode, depth: number): LayoutNode => {
    if (isPane(node)) return node;
    if (depth === path.length) return { ...node, sizes: alignSizes(sizes, node.children.length) };
    const index = path[depth];
    if (index < 0 || index >= node.children.length) return node;
    const children = node.children.slice();
    children[index] = rewrite(children[index], depth + 1);
    return { ...node, children };
  };
  return rewrite(root, 0);
}

/** Swap two leaves in place — reorder without disturbing the tree shape. */
export function swapPanes(root: LayoutNode, a: number, b: number): LayoutNode {
  if (a === b || !layoutHasSession(root, a) || !layoutHasSession(root, b)) return root;
  const rewrite = (node: LayoutNode): LayoutNode => {
    if (isPane(node)) {
      if (node.sessionId === a) return { type: 'pane', sessionId: b };
      if (node.sessionId === b) return { type: 'pane', sessionId: a };
      return node;
    }
    return { ...node, children: node.children.map(rewrite) };
  };
  return rewrite(root);
}

/**
 * Project ratio sizes onto an integer pixel budget.
 *
 * Ratios stay the stored truth (viewers disagree on viewport size, so
 * absolute sizes cannot); the projection borrows the tmux/zellij discipline:
 * round each share, then hand the rounding error out one pixel at a time —
 * to the smallest children when growing, the largest when shrinking — so the
 * distribution never visibly jumps. A floor is enforced when the budget
 * allows it at all.
 */
export function discretizeSizes(sizes: number[], totalPx: number, minPx = 0): number[] {
  const count = sizes.length;
  if (count === 0) return [];
  const shares = normalize(alignSizes(sizes, count));
  const floor = minPx * count <= totalPx ? minPx : Math.floor(totalPx / count);
  const px = shares.map((s) => Math.max(floor, Math.round(s * totalPx)));

  let error = totalPx - px.reduce((a, v) => a + v, 0);
  const order = px.map((v, i) => i).sort((x, y) => (error > 0 ? px[x] - px[y] : px[y] - px[x]));
  let guard = count * Math.abs(error) + count;
  while (error !== 0 && guard-- > 0) {
    for (const i of order) {
      if (error === 0) break;
      if (error > 0) { px[i] += 1; error -= 1; }
      else if (px[i] > floor) { px[i] -= 1; error += 1; }
    }
  }
  return px;
}

/**
 * Build a layout from a bare list of ids.
 *
 * This is the old behaviour, kept only for first-time construction where there
 * is no prior tree to preserve. Mutations must not route through it.
 */
export function layoutFromSessionIds(ids: number[]): LayoutNode {
  const clean = ids.filter((id) => id > 0);
  if (clean.length === 0) return EMPTY_PANE;
  if (clean.length === 1) return { type: 'pane', sessionId: clean[0] };
  return split('row', clean.map((id) => ({ type: 'pane' as const, sessionId: id })), clean.map(() => 1 / clean.length));
}
