import { describe, expect, it } from 'vitest';
import {
  CHART_TEMPLATE_CAP_EXCEEDED,
  CHART_TEMPLATE_CAP_UNSET,
  LAYOUT_CAP_EXCEEDED,
  LAYOUT_CAP_UNSET,
  LAYOUT_RESTORE_LIST_FULL,
  LAYOUT_RESTORE_UNSET,
  layoutsForRead,
  parseChartTemplates,
  parseLayouts,
  type LayoutCaps,
} from './layouts.js';
import { PREFERENCES_VALUE_INVALID } from './trade-views.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-23T12:00:00Z');
const caps: LayoutCaps = { layoutCap: 3, restoreDays: 7, restoreListSize: 2, templateCap: 2 };

const snapshot = {
  symbol: 'BTC/USDT',
  interval: '15m',
  mode: 'candles',
  scheme: 'standard',
  desk: { preset: 'advanced', side: 'right', studies: true, drawings: true },
  firstGroup: 'blue',
  grid: {
    layout: 'single',
    sync: { symbol: true, interval: true, crosshair: false, range: false },
    cells: [],
    sizes: { cols: [1, 1], rows: [1, 1] },
  },
  studies: [],
  drawings: { items: [] },
};
const layout = (id: string, name = 'Scalp') => ({ id, name, savedAt: '2026-10-22T09:00:00Z', snapshot });
const codeOf = (fn: () => unknown) => {
  try {
    fn();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? (error as Error).message;
  }
};

describe('saved layouts (trade.layouts)', () => {
  it('keeps layouts under the owner cap and returns them unchanged', () => {
    const value = { layouts: [layout('scalp')], deleted: [] };
    expect(parseLayouts(value, caps, NOW)).toEqual(value);
  });

  it('refuses a save while the layout cap is blank, never over a guessed limit', () => {
    const value = { layouts: [layout('scalp')], deleted: [] };
    expect(codeOf(() => parseLayouts(value, { ...caps, layoutCap: null }, NOW))).toBe(LAYOUT_CAP_UNSET);
  });

  it('refuses a layout over the cap as a whole', () => {
    const value = { layouts: ['a', 'b', 'c', 'd'].map((id) => layout(id)), deleted: [] };
    expect(codeOf(() => parseLayouts(value, caps, NOW))).toBe(LAYOUT_CAP_EXCEEDED);
  });

  it('refuses a deleted layout while the restore window or the restore list is blank', () => {
    const value = { layouts: [], deleted: [{ layout: layout('old'), deletedAt: '2026-10-22T09:00:00Z' }] };
    expect(codeOf(() => parseLayouts(value, { ...caps, restoreDays: null }, NOW))).toBe(LAYOUT_RESTORE_UNSET);
    expect(codeOf(() => parseLayouts(value, { ...caps, restoreListSize: null }, NOW))).toBe(LAYOUT_RESTORE_UNSET);
  });

  it('refuses more deleted layouts than the restore list holds', () => {
    const deleted = ['a', 'b', 'c'].map((id) => ({ layout: layout(id), deletedAt: '2026-10-22T09:00:00Z' }));
    expect(codeOf(() => parseLayouts({ layouts: [], deleted }, caps, NOW))).toBe(LAYOUT_RESTORE_LIST_FULL);
  });

  it('drops a deleted layout past the restore window when it writes', () => {
    const old = { layout: layout('old'), deletedAt: new Date(NOW - 8 * DAY).toISOString() };
    const recent = { layout: layout('recent'), deletedAt: new Date(NOW - 1 * DAY).toISOString() };
    const stored = parseLayouts({ layouts: [], deleted: [old, recent] }, caps, NOW);
    expect(stored.deleted.map((entry) => entry.layout.id)).toEqual(['recent']);
  });

  it('does not return a deleted layout past the window on read, and keeps none while the window is blank', () => {
    const value = {
      layouts: [layout('scalp')],
      deleted: [{ layout: layout('old'), deletedAt: new Date(NOW - 8 * DAY).toISOString() }],
    };
    expect(layoutsForRead(value, caps, NOW)?.deleted).toEqual([]);
    expect(layoutsForRead(value, { ...caps, restoreDays: null }, NOW)?.deleted).toEqual([]);
    expect(layoutsForRead(value, caps, NOW)?.layouts).toEqual(value.layouts);
  });

  it('refuses a shape it does not know, with the value-invalid code', () => {
    expect(codeOf(() => parseLayouts({ layouts: [{ ...layout('x'), extra: true }], deleted: [] }, caps, NOW))).toBe(
      PREFERENCES_VALUE_INVALID,
    );
  });

  it('refuses a snapshot that carries candles or an unknown key', () => {
    const bad = { layouts: [{ ...layout('x'), snapshot: { ...snapshot, candles: [] } }], deleted: [] };
    expect(codeOf(() => parseLayouts(bad, caps, NOW))).toBe(PREFERENCES_VALUE_INVALID);
  });
});

describe('chart templates (trade.chart-templates)', () => {
  const template = (id: string) => ({
    id,
    name: 'RSI',
    savedAt: '2026-10-22T09:00:00Z',
    interval: '1h',
    mode: 'candles',
    studies: [{ studies: [] }],
    drawings: { items: [] },
  });

  it('keeps templates under the owner cap', () => {
    expect(parseChartTemplates([template('rsi')], caps)).toHaveLength(1);
  });

  it('refuses a template while the template cap is blank', () => {
    expect(codeOf(() => parseChartTemplates([template('rsi')], { ...caps, templateCap: null }))).toBe(CHART_TEMPLATE_CAP_UNSET);
  });

  it('refuses templates over the cap', () => {
    expect(codeOf(() => parseChartTemplates(['a', 'b', 'c'].map(template), caps))).toBe(CHART_TEMPLATE_CAP_EXCEEDED);
  });
});
