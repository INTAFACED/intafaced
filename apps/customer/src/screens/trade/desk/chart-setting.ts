/**
 * The desk chart's setting on this device (interval and candles or line), shared by the chart panel and the saved
 * layouts, which keep the interval a layout was saved on.
 */
import { CHART_INTERVALS, MORE_INTERVALS, type ChartInterval } from '../chart/candles';

export type ChartMode = 'candles' | 'line';
export interface ChartSetting {
  interval: ChartInterval;
  mode: ChartMode;
}

export const CHART_SETTING_KEY = 'trade-desk-chart';
export const CHART_SETTING_DEFAULT: ChartSetting = { interval: '15m', mode: 'candles' };

export const isChartInterval = (value: unknown): value is ChartInterval =>
  typeof value === 'string' && ([...CHART_INTERVALS, ...MORE_INTERVALS] as readonly string[]).includes(value);

export const isChartSetting = (value: unknown): value is ChartSetting =>
  typeof value === 'object' &&
  value !== null &&
  isChartInterval((value as Partial<ChartSetting>).interval) &&
  ((value as Partial<ChartSetting>).mode === 'candles' || (value as Partial<ChartSetting>).mode === 'line');

/** The interval the desk chart shows on this device now. */
export function currentChartInterval(): ChartInterval {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(CHART_SETTING_KEY) ?? 'null');
    return isChartSetting(stored) ? stored.interval : CHART_SETTING_DEFAULT.interval;
  } catch {
    return CHART_SETTING_DEFAULT.interval;
  }
}

/**
 * Keep `interval` as the desk chart's interval on this device, for a desk about to open on another market (a saved
 * layout opened there): that desk mounts afresh and reads the setting, so a request held by this one would be lost.
 */
export function storeChartInterval(interval: ChartInterval): void {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(CHART_SETTING_KEY) ?? 'null');
    const current = isChartSetting(stored) ? stored : CHART_SETTING_DEFAULT;
    localStorage.setItem(CHART_SETTING_KEY, JSON.stringify({ ...current, interval }));
  } catch {
    /* Display settings remain usable without browser storage. */
  }
}
