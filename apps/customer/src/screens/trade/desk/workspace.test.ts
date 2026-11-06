import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LAYOUT,
  gridColumns,
  isDeskLayout,
  isUntouched,
  presetLayout,
  resizeWidget,
  swapWidgets,
  FIXED_TOTAL_MAX,
  WIDTH_MAX,
  WIDTH_MIN,
} from './workspace';

describe('desk presets', () => {
  it('Classic is today’s desk and Advanced adds the market trades widget', () => {
    expect(DEFAULT_LAYOUT.preset).toBe('classic');
    expect(presetLayout('classic').order).toEqual(['markets', 'chart', 'book']);
    expect(presetLayout('advanced').order).toEqual(['markets', 'chart', 'book', 'trades']);
    // 216 px and 264 px at the 16 px root, as the Classic grid draws them today.
    expect(gridColumns(presetLayout('classic'))).toBe('13.5rem minmax(0, 1fr) 16.5rem');
  });

  it('hands out a fresh copy, so changing one layout never changes the preset', () => {
    const one = presetLayout('advanced');
    (one.order as string[]).reverse();
    expect(presetLayout('advanced').order).toEqual(['markets', 'chart', 'book', 'trades']);
  });
});

describe('arranging', () => {
  it('dropping one widget on another swaps the two and leaves the rest', () => {
    const swapped = swapWidgets(presetLayout('advanced'), 'book', 'markets');
    expect(swapped.order).toEqual(['book', 'chart', 'markets', 'trades']);
    expect(isUntouched(swapped)).toBe(false);
    expect(swapWidgets(swapped, 'chart', 'chart')).toBe(swapped);
  });

  it('resizes inside the bounds, in quarter rems, and never the chart', () => {
    const wider = resizeWidget(presetLayout('classic'), 'markets', 4.1);
    expect(wider.widths.markets).toBe(17.5);
    expect(resizeWidget(wider, 'markets', 100).widths.markets).toBe(Math.min(WIDTH_MAX, FIXED_TOTAL_MAX - 16.5));
    expect(resizeWidget(wider, 'markets', -100).widths.markets).toBe(WIDTH_MIN);
    expect(resizeWidget(presetLayout('classic'), 'trades', 2)).toEqual(presetLayout('classic'));
    expect(gridColumns(wider)).toBe('17.5rem minmax(0, 1fr) 16.5rem');
  });

  it('the fixed widgets together never crowd out the chart', () => {
    let layout = presetLayout('advanced');
    for (const id of ['markets', 'book', 'trades'] as const) layout = resizeWidget(layout, id, 100);
    const total = (layout.widths.markets ?? 0) + (layout.widths.book ?? 0) + (layout.widths.trades ?? 0);
    expect(total).toBeLessThanOrEqual(FIXED_TOTAL_MAX);
    expect(isDeskLayout({ ...layout, widths: { markets: 32, book: 32, trades: 32 } })).toBe(false);
  });

  it('a reset is the preset again', () => {
    const arranged = resizeWidget(swapWidgets(presetLayout('advanced'), 'book', 'markets'), 'markets', 3);
    expect(isUntouched(arranged)).toBe(false);
    expect(isUntouched(presetLayout(arranged.preset))).toBe(true);
  });
});

describe('a stored layout', () => {
  it('is used only when the desk can draw every part of it', () => {
    expect(isDeskLayout(presetLayout('advanced'))).toBe(true);
    expect(isDeskLayout(swapWidgets(presetLayout('advanced'), 'book', 'markets'))).toBe(true);
    for (const broken of [
      null,
      'classic',
      { ...presetLayout('classic'), v: 2 },
      { ...presetLayout('classic'), preset: 'mimic' },
      { ...presetLayout('classic'), order: ['markets', 'chart'] },
      { ...presetLayout('classic'), order: ['markets', 'chart', 'chart'] },
      { ...presetLayout('classic'), order: ['markets', 'chart', 'book', 'trades'] },
      { ...presetLayout('classic'), widths: { markets: 2, book: 16.5 } },
      { ...presetLayout('classic'), widths: { markets: Number.NaN, book: 16.5 } },
      { ...presetLayout('classic'), widths: { book: 16.5 } },
    ]) {
      expect(isDeskLayout(broken), JSON.stringify(broken)).toBe(false);
    }
  });
});
