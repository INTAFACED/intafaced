import { describe, expect, it } from 'vitest';
import {
  CHART_TEMPLATE_CAP_EXCEEDED,
  CHART_TEMPLATE_CAP_UNSET,
  LAYOUT_CAP_EXCEEDED,
  LAYOUT_CAP_UNSET,
  layoutsForRead,
  parseChartTemplateShape,
  parseLayoutShape,
  settleChartTemplates,
  settleLayouts,
  type LayoutCaps,
} from './layouts.js';
import { PREFERENCES_VALUE_INVALID } from './trade-views.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-23T12:00:00Z');
const caps: LayoutCaps = { layoutCap: 3, restoreDays: 7, restoreListSize: 2, templateCap: 2 };
const NO_CAPS: LayoutCaps = { layoutCap: null, restoreDays: null, restoreListSize: null, templateCap: null };

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
const deletedAt = (days: number) => new Date(NOW - days * DAY).toISOString();
const codeOf = (fn: () => unknown) => {
  try {
    fn();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? (error as Error).message;
  }
};

describe('saved layouts (trade.layouts)', () => {
  it('checks the shape: an unknown key or a candle array is refused', () => {
    expect(codeOf(() => parseLayoutShape({ layouts: [{ ...layout('x'), extra: true }], deleted: [] }))).toBe(PREFERENCES_VALUE_INVALID);
    const bad = { layouts: [{ ...layout('x'), snapshot: { ...snapshot, candles: [] } }], deleted: [] };
    expect(codeOf(() => parseLayoutShape(bad))).toBe(PREFERENCES_VALUE_INVALID);
  });

  it('a save that grows the list needs the layout cap: blank refuses, over the cap refuses', () => {
    const grown = { layouts: [layout('a')], deleted: [] };
    expect(codeOf(() => settleLayouts(grown, null, NO_CAPS, NOW))).toBe(LAYOUT_CAP_UNSET);
    const full = { layouts: ['a', 'b', 'c', 'd'].map((id) => layout(id)), deleted: [] };
    expect(codeOf(() => settleLayouts(full, { layouts: full.layouts.slice(0, 3), deleted: [] }, caps, NOW))).toBe(LAYOUT_CAP_EXCEEDED);
  });

  it('an update of an existing list passes even while the layout cap is blank', () => {
    const before = { layouts: [layout('a')], deleted: [] };
    const edited = { layouts: [{ ...layout('a'), name: 'Scalp 2' }], deleted: [] };
    expect(settleLayouts(edited, before, NO_CAPS, NOW)).toEqual(edited);
  });

  it('a delete always passes, even while the restore caps are blank; the entry is kept only inside the caps', () => {
    const before = { layouts: [layout('a')], deleted: [] };
    const removed = { layouts: [], deleted: [{ layout: layout('a'), deletedAt: deletedAt(0) }] };
    expect(settleLayouts(removed, before, NO_CAPS, NOW).deleted).toEqual([]);
    expect(settleLayouts(removed, before, caps, NOW).deleted).toHaveLength(1);
  });

  it('stamps the time the server first sees a layout deleted; a client time is never stored', () => {
    const before = { layouts: [layout('a')], deleted: [] };
    const claimed = { layouts: [], deleted: [{ layout: layout('a'), deletedAt: deletedAt(60) }] };
    const [entry] = settleLayouts(claimed, before, caps, NOW).deleted;
    expect(entry?.deletedAt).toBe(new Date(NOW).toISOString());
  });

  it('keeps the stored time of a layout that was already deleted', () => {
    const stored = { layouts: [], deleted: [{ layout: layout('a'), deletedAt: deletedAt(3) }] };
    const again = { layouts: [], deleted: [{ layout: layout('a'), deletedAt: deletedAt(0) }] };
    expect(settleLayouts(again, stored, caps, NOW).deleted[0]?.deletedAt).toBe(deletedAt(3));
  });

  it('a recover grows the list and so needs the cap', () => {
    const before = { layouts: [], deleted: [{ layout: layout('a'), deletedAt: deletedAt(1) }] };
    const recovered = { layouts: [layout('a')], deleted: [] };
    expect(codeOf(() => settleLayouts(recovered, before, NO_CAPS, NOW))).toBe(LAYOUT_CAP_UNSET);
    expect(settleLayouts(recovered, before, caps, NOW).layouts).toHaveLength(1);
  });

  it('trims the restore list to the owner size, newest first', () => {
    const many = { layouts: [], deleted: ['a', 'b', 'c'].map((id) => ({ layout: layout(id), deletedAt: deletedAt(0) })) };
    expect(settleLayouts(many, null, caps, NOW).deleted.map((entry) => entry.layout.id)).toEqual(['a', 'b']);
  });

  it('drops a deleted layout past the window when it writes, and does not return it on read', () => {
    const old = { layout: layout('old'), deletedAt: deletedAt(8) };
    const recent = { layout: layout('recent'), deletedAt: deletedAt(1) };
    // The old entry was stamped eight days ago when the server first saw it: the next write drops it.
    const stored = settleLayouts({ layouts: [], deleted: [old, recent] }, { layouts: [], deleted: [old] }, caps, NOW);
    expect(stored.deleted.map((entry) => entry.layout.id)).toEqual(['recent']);
    const raw = { layouts: [layout('scalp')], deleted: [old] };
    expect(layoutsForRead(raw, caps, NOW)?.deleted).toEqual([]);
    expect(layoutsForRead(raw, { ...caps, restoreDays: null }, NOW)?.deleted).toEqual([]);
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

  it('checks the shape', () => {
    expect(codeOf(() => parseChartTemplateShape([{ ...template('x'), extra: 1 }]))).toBe(PREFERENCES_VALUE_INVALID);
  });

  it('a new template needs the template cap; an edit passes while it is blank', () => {
    expect(codeOf(() => settleChartTemplates([template('rsi')], [], { ...caps, templateCap: null }))).toBe(CHART_TEMPLATE_CAP_UNSET);
    expect(settleChartTemplates([template('rsi')], [template('rsi')], { ...caps, templateCap: null })).toHaveLength(1);
  });

  it('refuses growth over the cap', () => {
    const three = ['a', 'b', 'c'].map(template);
    expect(codeOf(() => settleChartTemplates(three, [template('a'), template('b')], caps))).toBe(CHART_TEMPLATE_CAP_EXCEEDED);
  });
});
