/**
 * The six starting layouts (PRO-TERMINAL-PLAN section 3). Each is a plain `WorkspaceV1` tree built from the
 * panels the desk has today; a preset that names a panel this build does not know is pruned on load, never drawn
 * half empty (`pruneWorkspace`).
 *
 * Weights are shares of the parent split, not pixels. At 1440 x 900 the Classic side columns come out near 280 px.
 */
import {
  WORKSPACE_VERSION,
  type LayoutNode,
  type PanelRef,
  type PresetId,
  type SplitNode,
  type StackNode,
  type WorkspaceV1,
} from './workspace';

export interface PresetInfo {
  id: PresetId;
  name: string;
  /** One plain sentence for the picker. */
  about: string;
}

export const PRESETS: readonly PresetInfo[] = [
  { id: 'classic', name: 'Classic', about: 'Markets, chart over ticket, book and trades, orders below. The layout most traders know.' },
  { id: 'chart-focus', name: 'Chart focus', about: 'A big chart with a compact ticket and a narrow book beside it.' },
  { id: 'scalper', name: 'Scalper', about: 'Book and trades tape side by side, with the ticket and one chart.' },
  { id: 'book-focus', name: 'Book focus', about: 'A tall order book and trades, with a small chart and the ticket.' },
  { id: 'multi-market', name: 'Multi-market', about: 'A wide markets list for hopping between pairs, with chart, book and ticket.' },
  { id: 'minimal', name: 'Minimal', about: 'Just the chart, the ticket and your orders.' },
];

const panel = (type: string): PanelRef => ({ id: type, type, link: 'lime', settings: {} });
const stack = (weight: number, types: string[], selected = 0): StackNode => ({ kind: 'stack', weight, selected, panels: types.map(panel) });
const split = (direction: 'row' | 'column', weight: number, children: LayoutNode[]): SplitNode => ({
  kind: 'split',
  direction,
  weight,
  children,
});

const TREES: Record<PresetId, () => LayoutNode> = {
  classic: () =>
    split('column', 100, [
      split('row', 76, [
        stack(20, ['markets']),
        split('column', 60, [stack(54, ['chart']), stack(46, ['ticket'])]),
        stack(20, ['orderbook', 'trades']),
      ]),
      stack(24, ['orders']),
    ]),
  'chart-focus': () =>
    split('column', 100, [
      split('row', 80, [stack(72, ['chart']), split('column', 28, [stack(54, ['ticket']), stack(46, ['orderbook', 'trades'])])]),
      stack(20, ['orders']),
    ]),
  scalper: () =>
    split('column', 100, [
      split('row', 78, [
        stack(27, ['orderbook']),
        stack(21, ['trades']),
        split('column', 52, [stack(50, ['chart']), stack(50, ['ticket'])]),
      ]),
      stack(22, ['orders']),
    ]),
  'book-focus': () =>
    split('row', 100, [
      stack(34, ['orderbook']),
      split('column', 46, [stack(36, ['chart']), stack(38, ['ticket']), stack(26, ['orders'])]),
      stack(20, ['trades']),
    ]),
  'multi-market': () =>
    split('row', 100, [
      stack(30, ['markets']),
      split('column', 46, [stack(62, ['chart']), stack(38, ['orders'])]),
      split('column', 24, [stack(52, ['orderbook', 'trades']), stack(48, ['ticket'])]),
    ]),
  minimal: () => split('column', 100, [split('row', 76, [stack(68, ['chart']), stack(32, ['ticket'])]), stack(24, ['orders'])]),
};

export function isPresetId(value: unknown): value is PresetId {
  return typeof value === 'string' && value in TREES;
}

export function presetInfo(id: PresetId): PresetInfo {
  return PRESETS.find((preset) => preset.id === id)!;
}

/** A fresh workspace from a preset. The caller picks the id, so two workspaces never share one. */
export function workspaceFromPreset(id: PresetId, workspaceId: string, name: string = presetInfo(id).name): WorkspaceV1 {
  return { version: WORKSPACE_VERSION, id: workspaceId, name, preset: id, locked: false, tree: TREES[id]() };
}

export const DEFAULT_PRESET: PresetId = 'classic';
