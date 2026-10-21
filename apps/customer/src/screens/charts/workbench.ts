/**
 * The chart workbench's shared state: one symbol (the address), one interval and one chart style, read by every widget on
 * the page. The interval and style are kept per workbench on this device (a person's own display choice, never money).
 */
import { CHART_INTERVALS, MORE_INTERVALS, type ChartInterval } from '../trade/chart/candles';

export const ALL_INTERVALS: readonly ChartInterval[] = [...CHART_INTERVALS, ...MORE_INTERVALS];
export const DEFAULT_INTERVAL: ChartInterval = '15m';
export type ChartMode = 'candles' | 'line';
export interface WorkbenchSetting {
  interval: ChartInterval;
  mode: ChartMode;
}
export const DEFAULT_SETTING: WorkbenchSetting = { interval: DEFAULT_INTERVAL, mode: 'candles' };
export const DEFAULT_WORKBENCH = 'main';

export const isChartInterval = (value: unknown): value is ChartInterval => (ALL_INTERVALS as readonly unknown[]).includes(value);
/** A stored setting that is not in the offered set is ignored (the default stands), with no error. */
export const isWorkbenchSetting = (value: unknown): value is WorkbenchSetting =>
  typeof value === 'object' &&
  value !== null &&
  isChartInterval((value as WorkbenchSetting).interval) &&
  ((value as WorkbenchSetting).mode === 'candles' || (value as WorkbenchSetting).mode === 'line');

const WORKBENCH_ID = /^[A-Za-z0-9_-]{1,32}$/;
/** `?w=<id>` names the workbench; without one every person has one of their own. */
export function workbenchId(search: string): string {
  const id = new URLSearchParams(search).get('w');
  return id !== null && WORKBENCH_ID.test(id) ? id : DEFAULT_WORKBENCH;
}
/** `?interval=15m` opens the workbench at that interval. An unknown one is ignored. */
export function intervalFromSearch(search: string): ChartInterval | undefined {
  const value = new URLSearchParams(search).get('interval');
  return isChartInterval(value) ? value : undefined;
}
export const settingKey = (userId: string | null, id: string): string => `charts-workbench:${userId ?? 'guest'}:${id}`;

export const intervalLabel = (interval: ChartInterval): string => (interval === '1d' ? '1D' : interval === '1w' ? '1W' : interval);

/** The address of a symbol on a workbench, as the desk spells pairs (`BTC-USDT`). */
export function chartsHref(pair: string, options: { interval?: ChartInterval; workbench?: string } = {}): string {
  const query = new URLSearchParams();
  if (options.workbench && options.workbench !== DEFAULT_WORKBENCH) query.set('w', options.workbench);
  if (options.interval) query.set('interval', options.interval);
  const text = query.toString();
  return `/charts/${encodeURIComponent(pair)}${text ? `?${text}` : ''}`;
}
