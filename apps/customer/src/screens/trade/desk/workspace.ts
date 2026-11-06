/**
 * The spot desk as a widget workspace (C-workspace-01, J-charts-desk-07 #1 and #2): which widgets the desk shows, in
 * which order, and how wide the fixed-width ones are. Pure rules, no React. Kept per person and per device until the
 * account copy of layouts exists (C-workspace-02).
 *
 * Widths are in rem and bounded by the UI (`WIDTH_MIN` to `WIDTH_MAX`): a layout choice, not an owner value. The chart
 * takes whatever space is left, so it has no width of its own.
 */

export const WIDGET_IDS = ['markets', 'chart', 'book', 'trades'] as const;
export type WidgetId = (typeof WIDGET_IDS)[number];
export type SizedWidget = Exclude<WidgetId, 'chart'>;

export const PRESET_IDS = ['classic', 'advanced'] as const;
export type PresetId = (typeof PRESET_IDS)[number];

export interface DeskLayout {
  readonly v: 1;
  /** The preset the layout started from; reset returns to it. */
  readonly preset: PresetId;
  /** The widgets shown, left to right (start to end). */
  readonly order: readonly WidgetId[];
  /** Width in rem of each shown widget except the chart. */
  readonly widths: Readonly<Partial<Record<SizedWidget, number>>>;
}

export const WIDTH_MIN = 10;
export const WIDTH_MAX = 32;

/** Classic is today's desk (markets | chart and ticket | book, 216 and 264 px at the 16 px root); Advanced adds the tape. */
const PRESETS: Record<PresetId, DeskLayout> = {
  classic: { v: 1, preset: 'classic', order: ['markets', 'chart', 'book'], widths: { markets: 13.5, book: 16.5 } },
  advanced: {
    v: 1,
    preset: 'advanced',
    order: ['markets', 'chart', 'book', 'trades'],
    widths: { markets: 13.5, book: 16.5, trades: 16.5 },
  },
};

export function presetLayout(id: PresetId): DeskLayout {
  const preset = PRESETS[id];
  return { ...preset, order: [...preset.order], widths: { ...preset.widths } };
}

export const DEFAULT_LAYOUT: DeskLayout = presetLayout('classic');

/** True when the layout is exactly a preset as shipped: nothing moved or resized. */
export function isUntouched(layout: DeskLayout): boolean {
  const preset = PRESETS[layout.preset];
  return (
    layout.order.length === preset.order.length &&
    layout.order.every((id, i) => id === preset.order[i]) &&
    layout.order.every((id) => id === 'chart' || layout.widths[id] === preset.widths[id])
  );
}

const isWidget = (value: unknown): value is WidgetId => typeof value === 'string' && (WIDGET_IDS as readonly string[]).includes(value);

/** A stored layout is used only when every part of it is one the desk can draw; anything else is not a layout. */
export function isDeskLayout(value: unknown): value is DeskLayout {
  if (typeof value !== 'object' || value === null) return false;
  const layout = value as Partial<DeskLayout>;
  if (layout.v !== 1 || !(PRESET_IDS as readonly unknown[]).includes(layout.preset)) return false;
  const order = layout.order;
  if (!Array.isArray(order) || !order.every(isWidget) || new Set(order).size !== order.length) return false;
  // The set of widgets belongs to the preset: moving changes the order, never what is shown.
  const expected = PRESETS[layout.preset as PresetId].order;
  if (order.length !== expected.length || !expected.every((id) => order.includes(id))) return false;
  const widths = layout.widths;
  if (typeof widths !== 'object' || widths === null) return false;
  return order.every((id) => {
    if (id === 'chart') return true;
    const width = (widths as Record<string, unknown>)[id];
    return typeof width === 'number' && Number.isFinite(width) && width >= WIDTH_MIN && width <= WIDTH_MAX;
  });
}

/** Dropping one widget on another swaps their places; the rest stay where they are. */
export function swapWidgets(layout: DeskLayout, moved: WidgetId, target: WidgetId): DeskLayout {
  const from = layout.order.indexOf(moved);
  const to = layout.order.indexOf(target);
  if (from < 0 || to < 0 || from === to) return layout;
  const order = [...layout.order];
  order[from] = target;
  order[to] = moved;
  return { ...layout, order };
}

/** Widen or narrow one widget by `deltaRem`, kept inside the bounds; the chart takes up the difference. */
export function resizeWidget(layout: DeskLayout, id: SizedWidget, deltaRem: number): DeskLayout {
  const current = layout.widths[id];
  if (current === undefined || !Number.isFinite(deltaRem)) return layout;
  const next = Math.round(Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, current + deltaRem)) * 4) / 4;
  if (next === current) return layout;
  return { ...layout, widths: { ...layout.widths, [id]: next } };
}

/** The grid's columns for the layout, start to end. */
export function gridColumns(layout: DeskLayout): string {
  return layout.order.map((id) => (id === 'chart' ? 'minmax(0, 1fr)' : `${layout.widths[id]}rem`)).join(' ');
}
