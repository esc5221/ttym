import type { LayoutNode } from './workspace-domain.js';

export type LayoutPreset = 'even-h' | 'even-v' | 'main-v' | 'tiled' | 'auto';

export const LAYOUT_PRESETS: LayoutPreset[] = ['even-h', 'even-v', 'main-v', 'tiled', 'auto'];

function pane(sessionId: number): LayoutNode {
  return { type: 'pane', sessionId };
}

function even(axis: 'row' | 'col', ids: number[]): LayoutNode {
  if (ids.length === 1) return pane(ids[0]!);
  return { type: 'split', axis, sizes: ids.map(() => 1 / ids.length), children: ids.map(pane) };
}

/**
 * Rebuild a workspace's layout from a preset, tmux-style: the same panes are
 * re-attached to a fresh tree — sessions never restart for a layout change.
 * Order is membership order, so the first member is the main pane.
 */
export function presetLayout(preset: LayoutPreset, ids: number[]): LayoutNode {
  if (ids.length === 0) return pane(0);
  if (ids.length === 1) return pane(ids[0]!);
  switch (preset) {
    case 'even-h': return even('row', ids);
    case 'even-v': return even('col', ids);
    case 'main-v': {
      const [main, ...rest] = ids;
      if (rest.length === 0) return pane(main!);
      return {
        type: 'split', axis: 'row', sizes: [0.6, 0.4],
        children: [pane(main!), even('col', rest)],
      };
    }
    case 'tiled': {
      // rows × columns, alternating growth (tmux layout_set_tiled): enough
      // cells for every pane, remainder absorbed by the last row.
      const columns = Math.ceil(Math.sqrt(ids.length));
      const rows: number[][] = [];
      for (let i = 0; i < ids.length; i += columns) rows.push(ids.slice(i, i + columns));
      if (rows.length === 1) return even('row', rows[0]!);
      return {
        type: 'split', axis: 'col', sizes: rows.map(() => 1 / rows.length),
        children: rows.map((row) => even('row', row)),
      };
    }
    case 'auto': return autoLayout(ids);
  }
}

/**
 * The swap-layout rules (zellij's idea, ttym's constants): the tree is chosen
 * by member count, so attaching and detaching agents keeps a sensible shape
 * without anyone dragging dividers.
 *
 *   1–2  side by side
 *   3–5  one main pane, the rest stacked beside it
 *   6+   tiled
 */
export function autoLayout(ids: number[]): LayoutNode {
  if (ids.length <= 2) return presetLayout('even-h', ids);
  if (ids.length <= 5) return presetLayout('main-v', ids);
  return presetLayout('tiled', ids);
}

export function isLayoutPreset(value: unknown): value is LayoutPreset {
  return typeof value === 'string' && (LAYOUT_PRESETS as string[]).includes(value);
}
