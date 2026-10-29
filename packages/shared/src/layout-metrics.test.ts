import { describe, expect, it } from 'vitest';
import { narrowestPanePx } from './layout-metrics.js';
import { sessionIdsToLayout } from './workspace-domain.js';
import type { LayoutNode } from './workspace-domain.js';

describe('narrowestPanePx', () => {
  it('a single pane gets the whole width', () => {
    expect(narrowestPanePx(sessionIdsToLayout([1]), 1700)).toBe(1700);
  });

  it('twelve equal columns share the width', () => {
    expect(narrowestPanePx(sessionIdsToLayout(Array.from({ length: 12 }, (_, i) => i + 1)), 1700)).toBeCloseTo(1700 / 12, 5);
  });

  it('splitter thickness comes out of the usable width', () => {
    expect(narrowestPanePx(sessionIdsToLayout([1, 2, 3]), 1000, 5)).toBeCloseTo((1000 - 10) / 3, 5);
  });

  it('stacked rows (col axis) do not narrow anything', () => {
    const stacked: LayoutNode = {
      type: 'split', axis: 'col', sizes: [0.5, 0.5],
      children: [{ type: 'pane', sessionId: 1 }, { type: 'pane', sessionId: 2 }],
    };
    expect(narrowestPanePx(stacked, 900)).toBe(900);
  });

  it('uses the stored ratios, not an even share', () => {
    const uneven: LayoutNode = {
      type: 'split', axis: 'row', sizes: [0.8, 0.2],
      children: [{ type: 'pane', sessionId: 1 }, { type: 'pane', sessionId: 2 }],
    };
    expect(narrowestPanePx(uneven, 1000)).toBeCloseTo(200, 5);
  });

  it('descends into nested splits', () => {
    const nested: LayoutNode = {
      type: 'split', axis: 'row', sizes: [0.5, 0.5],
      children: [
        { type: 'pane', sessionId: 1 },
        { type: 'split', axis: 'row', sizes: [0.5, 0.5], children: [{ type: 'pane', sessionId: 2 }, { type: 'pane', sessionId: 3 }] },
      ],
    };
    expect(narrowestPanePx(nested, 1000)).toBeCloseTo(250, 5);
  });
});
