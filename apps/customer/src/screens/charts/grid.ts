/**
 * The workbench's chart grid: how many charts, how they are arranged and sized, and which of them follow each other.
 * Kept per person and workbench on this device. The number of charts a grid may hold is an owner value
 * (`chartCountLimit`): a layout past it, or any layout of more than one chart while it is blank, is refused.
 */
import type { ChartInterval } from '../trade/chart/candles';
import { isChartStyle, type ChartStyle } from './chart-style';
import { isChartInterval } from './workbench';

export const LAYOUTS = {
  single: { cols: 1, rows: 1 },
  'two-across': { cols: 2, rows: 1 },
  'two-down': { cols: 1, rows: 2 },
  grid: { cols: 2, rows: 2 },
} as const;
export type LayoutId = keyof typeof LAYOUTS;
export const LAYOUT_IDS = Object.keys(LAYOUTS) as LayoutId[];
export const chartCount = (layout: LayoutId): number => LAYOUTS[layout].cols * LAYOUTS[layout].rows;

/** Colour tags for sync groups. A chart with no tag follows nothing and leads nothing. */
export const GROUPS = ['blue', 'green', 'orange'] as const;
export type Group = (typeof GROUPS)[number];

export interface SyncSet {
  symbol: boolean;
  interval: boolean;
  crosshair: boolean;
  range: boolean;
}
/** By default only symbol and interval link (spec C-workspace-04). */
export const DEFAULT_SYNC: SyncSet = { symbol: true, interval: true, crosshair: false, range: false };

export interface CellSetting {
  symbol: string;
  interval: ChartInterval;
  mode: ChartStyle;
  group: Group | null;
}

export interface GridSetting {
  layout: LayoutId;
  sync: SyncSet;
  /** Every cell after the first; the first is the address's market and the workbench's own setting. */
  cells: CellSetting[];
  /** Column and row weights, as the borders were dragged (both 1 = even). */
  sizes: { cols: number[]; rows: number[] };
}

export const EVEN_SIZES = { cols: [1, 1], rows: [1, 1] };
export const DEFAULT_GRID: GridSetting = { layout: 'single', sync: DEFAULT_SYNC, cells: [], sizes: EVEN_SIZES };

const isGroup = (value: unknown): value is Group | null => value === null || (GROUPS as readonly unknown[]).includes(value);
const isCell = (value: unknown): value is CellSetting =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as CellSetting).symbol === 'string' &&
  isChartInterval((value as CellSetting).interval) &&
  isChartStyle((value as CellSetting).mode) &&
  isGroup((value as CellSetting).group);
const isWeights = (value: unknown): value is number[] =>
  Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number' && n >= 0.2 && n <= 5);

/** A stored grid that does not read as one is ignored (the single chart stands), with no error. */
export const isGridSetting = (value: unknown): value is GridSetting =>
  typeof value === 'object' &&
  value !== null &&
  (LAYOUT_IDS as readonly unknown[]).includes((value as GridSetting).layout) &&
  typeof (value as GridSetting).sync === 'object' &&
  (value as GridSetting).sync !== null &&
  (['symbol', 'interval', 'crosshair', 'range'] as const).every((k) => typeof (value as GridSetting).sync[k] === 'boolean') &&
  Array.isArray((value as GridSetting).cells) &&
  (value as GridSetting).cells.every(isCell) &&
  typeof (value as GridSetting).sizes === 'object' &&
  isWeights((value as GridSetting).sizes?.cols) &&
  isWeights((value as GridSetting).sizes?.rows);

export const gridKey = (userId: string | null, id: string): string => `charts-grid:${userId ?? 'guest'}:${id}`;

/** Why a layout cannot be used: the owner limit is blank, or the layout holds more charts than it allows. */
export function layoutRefusal(layout: LayoutId, limit: number | null): 'unset' | 'over' | null {
  if (chartCount(layout) === 1) return null;
  if (limit === null) return 'unset';
  return chartCount(layout) > limit ? 'over' : null;
}

/** One read of the owner's chart limit: its value, or why it cannot be used yet. */
export type LimitRead = { ok: true; value: number } | { ok: false; why: 'loading' | 'unavailable' | 'unset' };
export type LayoutReason = 'loading' | 'unavailable' | 'unset' | 'over';

/** Why a layout cannot be shown with this read of the limit, or null when it can. One chart always can. */
export function reasonFor(layout: LayoutId, limit: LimitRead): LayoutReason | null {
  if (chartCount(layout) === 1) return null;
  if (!limit.ok) return limit.why;
  return layoutRefusal(layout, limit.value) === null ? null : 'over';
}

/** The next layout in order that the limit allows, after `from`; null while the limit loads or when no other is allowed. */
export function limitedLayoutAfter(from: LayoutId, limit: LimitRead): LayoutId | null {
  const at = LAYOUT_IDS.indexOf(from);
  for (let step = 1; step < LAYOUT_IDS.length; step += 1) {
    const id = LAYOUT_IDS[(at + step) % LAYOUT_IDS.length]!;
    if (reasonFor(id, limit) === null) return id;
  }
  return null;
}

/** The stored cells after the first, with the ones on screen replaced; cells a smaller layout is not showing are kept. */
export const withVisible = (stored: readonly CellSetting[], visible: readonly CellSetting[]): CellSetting[] => [
  ...visible,
  ...stored.slice(visible.length),
];

/** The cells a layout shows: the stored ones first, new ones copying the first chart (and in the blue group). */
export function cellsFor(layout: LayoutId, first: CellSetting, stored: readonly CellSetting[]): CellSetting[] {
  const out: CellSetting[] = [first];
  for (let i = 1; i < chartCount(layout); i += 1) out.push(stored[i - 1] ?? { ...first, group: first.group ?? 'blue' });
  return out;
}

/**
 * A change made on one chart, applied to the charts that follow it: those in the same colour group, for the parts the
 * sync set links. A chart with no group changes alone.
 */
export function applyChange(
  cells: readonly CellSetting[],
  from: number,
  change: Partial<Pick<CellSetting, 'symbol' | 'interval' | 'mode'>>,
  sync: SyncSet,
): CellSetting[] {
  const group = cells[from]?.group ?? null;
  return cells.map((cell, i) => {
    if (i === from) return { ...cell, ...change };
    if (group === null || cell.group !== group) return cell;
    const next = { ...cell };
    if (change.symbol !== undefined && sync.symbol) next.symbol = change.symbol;
    if (change.interval !== undefined && sync.interval) next.interval = change.interval;
    return next;
  });
}

/** The charts that follow `from` for one linked part (crosshair or date range). */
export function followers(cells: readonly CellSetting[], from: number): number[] {
  const group = cells[from]?.group ?? null;
  if (group === null) return [];
  return cells.flatMap((cell, i) => (i !== from && cell.group === group ? [i] : []));
}

/** Dragging a border by `delta` of the grid's size moves weight from one side to the other, never below a fifth. */
export function resize(weights: readonly number[], delta: number): number[] {
  const total = weights[0]! + weights[1]!;
  const first = Math.min(total - 0.2 * total, Math.max(0.2 * total, weights[0]! + delta * total));
  return [first, total - first];
}
