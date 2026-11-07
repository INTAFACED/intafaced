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
