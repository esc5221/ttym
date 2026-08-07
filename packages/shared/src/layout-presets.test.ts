import { describe, expect, it } from 'vitest';
import { presetLayout, autoLayout } from './layout-presets.js';
import { layoutSessionIds } from './layout-tree.js';

describe('presetLayout', () => {
  it('keeps every pane across every preset — layouts rearrange, never drop', () => {
    const ids = [1, 2, 3, 4, 5, 6, 7];
    for (const preset of ['even-h', 'even-v', 'main-v', 'tiled', 'auto'] as const) {
      expect(layoutSessionIds(presetLayout(preset, ids)).sort()).toEqual(ids);
    }
  });

  it('main-v puts the first member in the main pane with a stacked side', () => {
    const tree = presetLayout('main-v', [9, 2, 3]) as any;
    expect(tree.axis).toBe('row');
    expect(tree.sizes).toEqual([0.6, 0.4]);
    expect(tree.children[0].sessionId).toBe(9);
    expect(tree.children[1].axis).toBe('col');
  });

  it('tiled balances rows and columns', () => {
    const tree = presetLayout('tiled', [1, 2, 3, 4, 5]) as any;
    expect(tree.axis).toBe('col');
    expect(tree.children.length).toBe(2);
    expect(tree.children[0].children.length).toBe(3);
  });

  it('auto follows the member-count rules', () => {
    expect((autoLayout([1, 2]) as any).axis).toBe('row');
    expect((autoLayout([1, 2, 3, 4]) as any).sizes).toEqual([0.6, 0.4]);
    expect((autoLayout([1, 2, 3, 4, 5, 6]) as any).children[0].children.length).toBeGreaterThan(1);
  });
});
