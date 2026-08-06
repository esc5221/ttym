import { describe, expect, it } from 'vitest';
import type { LayoutNode } from './workspace-domain';
import {
  insertPane,
  splitPane,
  removePane,
  resizeSplit,
  layoutSessionIds,
  layoutFromSessionIds,
} from './layout-tree';

/** row 0.7/0.3 with a nested col 0.5/0.5 on the right — the RFD's example. */
function nested(): LayoutNode {
  return {
    type: 'split',
    axis: 'row',
    sizes: [0.7, 0.3],
    children: [
      { type: 'pane', sessionId: 1 },
      {
        type: 'split',
        axis: 'col',
        sizes: [0.5, 0.5],
        children: [
          { type: 'pane', sessionId: 2 },
          { type: 'pane', sessionId: 3 },
        ],
      },
    ],
  };
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const ratio = (sizes: number[]) => sizes.map((s) => s / sizes[0]);

describe('layout tree — nesting survives', () => {
  it('keeps the nested subtree when a pane is added', () => {
    const after = insertPane(nested(), 4);
    expect(after.type).toBe('split');
    const root = after as Extract<LayoutNode, { type: 'split' }>;

    // The col split is still a col split with its own children.
    const inner = root.children[1];
    expect(inner.type).toBe('split');
    expect((inner as any).axis).toBe('col');
    expect(layoutSessionIds(inner)).toEqual([2, 3]);

    expect(layoutSessionIds(after)).toEqual([1, 2, 3, 4]);
  });

  it('keeps sibling ratios to each other when a pane is added', () => {
    const root = insertPane(nested(), 4) as Extract<LayoutNode, { type: 'split' }>;

    // 0.7 : 0.3 was 2.333…; it must still be 2.333… after the third child joins.
    expect(near(root.sizes[0] / root.sizes[1], 0.7 / 0.3)).toBe(true);
    expect(near(root.sizes.reduce((a, b) => a + b, 0), 1)).toBe(true);
    // The newcomer gets an equal share of the whole.
    expect(near(root.sizes[2], 1 / 3)).toBe(true);
  });

  it('leaves the inner split untouched byte for byte', () => {
    const before = nested();
    const innerBefore = JSON.stringify((before as any).children[1]);
    const after = insertPane(before, 4);
    expect(JSON.stringify((after as any).children[1])).toBe(innerBefore);
  });
});

describe('layout tree — split places beside a target', () => {
  it('replaces only the target pane and keeps its slot size', () => {
    const root = splitPane(nested(), 1, 9, 'col') as Extract<LayoutNode, { type: 'split' }>;

    // Root still has two slots at 0.7 / 0.3.
    expect(root.children.length).toBe(2);
    expect(near(root.sizes[0], 0.7)).toBe(true);
    expect(near(root.sizes[1], 0.3)).toBe(true);

    // Slot 0 is now a col split of 1 and 9.
    const slot0 = root.children[0] as any;
    expect(slot0.type).toBe('split');
    expect(slot0.axis).toBe('col');
    expect(layoutSessionIds(slot0)).toEqual([1, 9]);

    // Slot 1 — the sibling — is identical.
    expect(JSON.stringify(root.children[1])).toBe(JSON.stringify((nested() as any).children[1]));
  });

  it('honours the requested ratio', () => {
    const root = splitPane(nested(), 1, 9, 'row', 0.25) as any;
    expect(near(root.children[0].sizes[1], 0.25)).toBe(true);
  });

  it('falls back to a plain insert when the target is absent', () => {
    const after = splitPane(nested(), 99, 4);
    expect(layoutSessionIds(after)).toEqual([1, 2, 3, 4]);
  });

  it('refuses to add a session that is already placed', () => {
    const before = nested();
    expect(JSON.stringify(splitPane(before, 1, 2))).toBe(JSON.stringify(before));
    expect(JSON.stringify(insertPane(before, 3))).toBe(JSON.stringify(before));
  });
});

describe('layout tree — removal', () => {
  it('drops the pane and keeps remaining ratios', () => {
    const root = insertPane(nested(), 4) as any;
    const sizesBefore = root.sizes.slice(0, 2);

    const after = removePane(root, 4) as any;
    expect(layoutSessionIds(after)).toEqual([1, 2, 3]);
    // 0.7 : 0.3 is back to filling the whole width, ratio intact.
    expect(near(after.sizes[0] / after.sizes[1], sizesBefore[0] / sizesBefore[1])).toBe(true);
    expect(near(after.sizes.reduce((a: number, b: number) => a + b, 0), 1)).toBe(true);
  });

  it('collapses a split that is left with one child', () => {
    const after = removePane(nested(), 3) as any;
    // The col split held 2 and 3; with 3 gone it becomes just pane 2.
    expect(after.children[1]).toEqual({ type: 'pane', sessionId: 2 });
    expect(after.axis).toBe('row');
    expect(near(after.sizes[0] / after.sizes[1], 0.7 / 0.3)).toBe(true);
  });

  it('collapses all the way down to a single pane', () => {
    let node: LayoutNode = nested();
    node = removePane(node, 3);
    node = removePane(node, 2);
    expect(node).toEqual({ type: 'pane', sessionId: 1 });
  });

  it('leaves a placeholder when the last pane goes', () => {
    const node = removePane({ type: 'pane', sessionId: 1 }, 1);
    expect(node).toEqual({ type: 'pane', sessionId: 0 });
  });

  it('leaves the tree alone when the session is not in it', () => {
    const before = nested();
    expect(JSON.stringify(removePane(before, 99))).toBe(JSON.stringify(before));
  });
});

describe('layout tree — round trips and repair', () => {
  it('survives many adds and removes without flattening', () => {
    let node: LayoutNode = nested();
    for (const id of [4, 5, 6]) node = insertPane(node, id);
    for (const id of [5, 4]) node = removePane(node, id);

    const root = node as any;
    // Still nested, still 0.7 : 0.3 between the original two slots.
    expect(root.children[1].type).toBe('split');
    expect(near(root.sizes[0] / root.sizes[1], 0.7 / 0.3)).toBe(true);
    expect(layoutSessionIds(node)).toEqual([1, 2, 3, 6]);
  });

  it('repairs a split whose sizes do not match its children', () => {
    const broken: LayoutNode = {
      type: 'split', axis: 'row', sizes: [0.5],
      children: [{ type: 'pane', sessionId: 1 }, { type: 'pane', sessionId: 2 }],
    };
    const root = insertPane(broken, 3) as any;
    expect(root.sizes.length).toBe(3);
    expect(near(root.sizes.reduce((a: number, b: number) => a + b, 0), 1)).toBe(true);
  });

  it('fills the placeholder pane rather than splitting against it', () => {
    const node = insertPane({ type: 'pane', sessionId: 0 }, 7);
    expect(node).toEqual({ type: 'pane', sessionId: 7 });
  });

  it('resizes one split without disturbing the rest', () => {
    const before = nested();
    const after = resizeSplit(before, [], [0.2, 0.8]) as any;
    expect(ratio(after.sizes)).toEqual([1, 4]);
    expect(JSON.stringify(after.children)).toBe(JSON.stringify((before as any).children));
  });

  it('resizes a nested split by path', () => {
    const after = resizeSplit(nested(), [1], [0.9, 0.1]) as any;
    expect(near(after.children[1].sizes[0], 0.9)).toBe(true);
    expect(near(after.sizes[0], 0.7)).toBe(true); // parent untouched
  });
});

describe('layoutFromSessionIds — first-time construction only', () => {
  it('builds an even row split', () => {
    const node = layoutFromSessionIds([1, 2, 3]) as any;
    expect(node.axis).toBe('row');
    expect(node.sizes.every((s: number) => near(s, 1 / 3))).toBe(true);
  });

  it('returns a placeholder for an empty list', () => {
    expect(layoutFromSessionIds([])).toEqual({ type: 'pane', sessionId: 0 });
  });
});
