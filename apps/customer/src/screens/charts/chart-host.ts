/**
 * The workbench chart's seam: what the chart hands to the parts drawn on top of it (studies, drawings, alert and order
 * lines, comparison series). The workbench chart owns the one Lightweight Charts instance and the main series; each add-on
 * gets this host once the chart is ready, draws with it, and returns a cleanup that removes everything it added.
 *
 * Bars are the chart's own candles as the service sent them (decimal strings), oldest first. Time is epoch seconds, the
 * library's own unit.
 */
import type { Candle } from '../../data/types';

/** The parts of the vendored library (`features/trade/vendor`, Lightweight Charts 5.2.1) the add-ons use. */
export interface ChartLib {
  LineSeries: unknown;
  HistogramSeries: unknown;
  AreaSeries: unknown;
  BarSeries: unknown;
  CandlestickSeries: unknown;
  BaselineSeries: unknown;
  createSeriesMarkers(series: unknown, markers: unknown[]): { setMarkers(markers: unknown[]): void };
}

export interface ChartSeries {
  setData(data: unknown[]): void;
  update(point: unknown): void;
  applyOptions(options: Record<string, unknown>): void;
  createPriceLine(options: Record<string, unknown>): unknown;
  removePriceLine(line: unknown): void;
  attachPrimitive(primitive: unknown): void;
  detachPrimitive(primitive: unknown): void;
  priceToCoordinate(price: number): number | null;
  coordinateToPrice(y: number): number | null;
  dataByIndex(index: number, mismatchDirection?: number): unknown;
  seriesType(): string;
  getPane(): { paneIndex(): number };
  options(): Record<string, unknown>;
  data(): readonly unknown[];
}

export interface ChartApi {
  addSeries(definition: unknown, options?: Record<string, unknown>, pane?: number): ChartSeries;
  removeSeries(series: ChartSeries): void;
  panes(): Array<{
    setStretchFactor(factor: number): void;
    paneIndex(): number;
    moveTo(index: number): void;
    setHeight(height: number): void;
    getHeight(): number;
    getStretchFactor(): number;
  }>;
  removePane(index: number): void;
  timeScale(): {
    fitContent(): void;
    timeToCoordinate(time: number): number | null;
    coordinateToTime(x: number): number | null;
    coordinateToLogical(x: number): number | null;
    logicalToCoordinate(logical: number): number | null;
    getVisibleLogicalRange(): { from: number; to: number } | null;
    setVisibleLogicalRange(range: { from: number; to: number }): void;
    subscribeVisibleLogicalRangeChange(handler: (range: { from: number; to: number } | null) => void): void;
    unsubscribeVisibleLogicalRangeChange(handler: (range: { from: number; to: number } | null) => void): void;
    getVisibleRange(): { from: number; to: number } | null;
    setVisibleRange(range: { from: number; to: number }): void;
    subscribeVisibleTimeRangeChange(handler: (range: { from: number; to: number } | null) => void): void;
    unsubscribeVisibleTimeRangeChange(handler: (range: { from: number; to: number } | null) => void): void;
  };
  setCrosshairPosition(price: number, time: number, series: ChartSeries): void;
  clearCrosshairPosition(): void;
  subscribeCrosshairMove(
    handler: (param: { time?: number; point?: { x: number; y: number }; logical?: number; paneIndex?: number }) => void,
  ): void;
  unsubscribeCrosshairMove(
    handler: (param: { time?: number; point?: { x: number; y: number }; logical?: number; paneIndex?: number }) => void,
  ): void;
  subscribeClick(handler: (param: { time?: number; point?: { x: number; y: number }; logical?: number }) => void): void;
  unsubscribeClick(handler: (param: { time?: number; point?: { x: number; y: number }; logical?: number }) => void): void;
  applyOptions(options: Record<string, unknown>): void;
  options(): Record<string, unknown>;
  takeScreenshot(): HTMLCanvasElement;
  remove(): void;
}

export interface ChartHost {
  lib: ChartLib;
  chart: ChartApi;
  /** The main price series (candles, bars, line, area, columns or Heikin Ashi). */
  main: ChartSeries;
  /** The element the chart draws in; overlays (toolbars, legends) sit beside it, never inside the canvas. */
  element: HTMLElement;
  /** The market's tick size as a decimal string: every price an add-on shows or stores is rounded to it. */
  tickSize: string;
  symbol: string;
}

/** An add-on draws on the host and returns the function that removes all it added. */
export type ChartAddon = (host: ChartHost, bars: readonly Candle[]) => () => void;
