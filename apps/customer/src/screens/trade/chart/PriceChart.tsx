/**
 * PriceChart: the adapter between the desk and the vendored Lightweight Charts 5.2.1
 * (`features/trade/vendor`, Apache-2.0, notice kept beside the file). Candles or a line, a volume pane at a
 * quarter of the height, MA(5/10/20), the last-price tag on the axis, the person's open orders as price lines
 * and their fills as B/S markers. New ticks go through `series.update()`; the chart is never re-mounted for one.
 *
 * TradingView attribution stays on: `layout.attributionLogo: true` draws the logo link the licence asks for.
 * Colours come from the app's tokens at mount (`--if-*`), never from literals here.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { usePreferences } from '../../../shared/preferences';
import type { Candle } from '../../../data/types';
import type { ChartInterval } from './candles';
import {
  fillMarkers,
  legendValues,
  movingAverage,
  planUpdate,
  priceCoordinate,
  priceFormat,
  stepOf,
  toBar,
  toLinePoint,
  toVolumeBar,
  type FillMark,
  type Marker,
} from './chart-data';

interface SeriesApi {
  setData(data: unknown[]): void;
  update(point: unknown): void;
  applyOptions(options: Record<string, unknown>): void;
  createPriceLine(options: Record<string, unknown>): unknown;
  removePriceLine(line: unknown): void;
}
interface CrosshairParam {
  time?: number;
}
interface ChartApiLike {
  addSeries(definition: unknown, options?: Record<string, unknown>, pane?: number): SeriesApi;
  removeSeries(series: SeriesApi): void;
  remove(): void;
  panes(): Array<{ setStretchFactor(factor: number): void }>;
  timeScale(): { fitContent(): void };
  subscribeCrosshairMove(handler: (param: CrosshairParam) => void): void;
  unsubscribeCrosshairMove(handler: (param: CrosshairParam) => void): void;
}
interface Engine {
  createChart(host: HTMLElement, options: Record<string, unknown>): ChartApiLike;
  CandlestickSeries: unknown;
  LineSeries: unknown;
  HistogramSeries: unknown;
  createSeriesMarkers(series: SeriesApi, markers: Marker[]): { setMarkers(markers: Marker[]): void };
}
const engineOf = (): Engine | undefined => (window as unknown as { LightweightCharts?: Engine }).LightweightCharts;

interface Colors {
  bg: string;
  text: string;
  grid: string;
  line: string;
  up: string;
  down: string;
  volUp: string;
  volDown: string;
  accent: string;
  ma: [string, string, string];
}
function readColors(): Colors {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    bg: v('--if-bg'),
    text: v('--if-fg-2'),
    grid: v('--if-grid'),
    line: v('--if-line'),
    up: v('--if-up'),
    down: v('--if-down'),
    volUp: v('--if-vol-up'),
    volDown: v('--if-vol-down'),
    accent: v('--if-lime'),
    ma: [v('--if-ma-1'), v('--if-ma-2'), v('--if-ma-3')],
  };
}

export interface ChartOrderLine {
  price: string;
  side: 'buy' | 'sell';
}

export interface PriceChartProps {
  candles: readonly Candle[];
  mode: 'candles' | 'line';
  interval: ChartInterval;
  /** Changes when the market or interval changes: the view is fitted again, otherwise it is left where the person put it. */
  resetKey: string;
  tickSize: string;
  orderLines: readonly ChartOrderLine[];
  fills: readonly FillMark[];
  /** IANA zone, or undefined for the device's own. Times on the axis and legend follow the person's setting. */
  timeZone: string | undefined;
  labels: { buy: string; sell: string; open: string; high: string; low: string; close: string; change: string; chart: string };
}

const MA_PERIODS = [5, 10, 20] as const;

interface Zone {
  language: string;
  timeZone: string | undefined;
}
const stamp = (seconds: number, zone: Zone, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat(zone.language, { ...options, ...(zone.timeZone ? { timeZone: zone.timeZone } : {}) }).format(seconds * 1000);

/** Crosshair label on the time axis: "14 Oct, 02:15". */
export const axisTime = (seconds: number, zone: Zone): string =>
  stamp(seconds, zone, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** Tick labels, by the library's tick kind (0 year, 1 month, 2 day, 3 and 4 time): "02:15", "14", "Oct", "2026". */
export function tickMark(seconds: number, kind: number, zone: Zone): string {
  if (kind === 0) return stamp(seconds, zone, { year: 'numeric' });
  if (kind === 1) return stamp(seconds, zone, { month: 'short' });
  if (kind === 2) return stamp(seconds, zone, { day: 'numeric' });
  return stamp(seconds, zone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

export function PriceChart({ candles, mode, interval, resetKey, tickSize, orderLines, fills, timeZone, labels }: PriceChartProps) {
  const { upColor, language } = usePreferences();
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<Engine | null>(null);
  const chart = useRef<ChartApiLike | null>(null);
  const main = useRef<SeriesApi | null>(null);
  const volume = useRef<SeriesApi | null>(null);
  const averages = useRef<SeriesApi[]>([]);
  const markers = useRef<{ setMarkers(markers: Marker[]): void } | null>(null);
  const lines = useRef<unknown[]>([]);
  const shown = useRef<readonly Candle[] | null>(null);
  const fittedFor = useRef<string | null>(null);
  const latest = useRef(candles);
  latest.current = candles;
  const [ready, setReady] = useState(0); // bumps whenever the main series is (re)created
  const [hover, setHover] = useState<number | null>(null);

  // Legend: "14 Oct, 02:15" in the person's zone, like every other time in the app.
  const formatTime = useMemo(
    () => (seconds: number) =>
      // Day before month ("14 Oct"), like every other time in the app: plain "en" would write "Oct 14".
      new Intl.DateTimeFormat(language === 'en' ? 'en-GB' : language, {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        ...(timeZone ? { timeZone } : {}),
      }).format(seconds * 1000),
    [language, timeZone],
  );
  // The axis labels are drawn by the library, which reads UTC unless told otherwise (critic M3). The chart is created
  // once, so its formatters read the current zone and language from here.
  const zone = useRef({ language, timeZone });
  zone.current = { language, timeZone };

  // One chart per mount.
  useEffect(() => {
    let closed = false;
    let api: ChartApiLike | null = null;
    let onMove: ((param: CrosshairParam) => void) | null = null;
    void import('../../../features/trade/vendor/lightweight-charts.standalone.production.js').then(() => {
      const lib = engineOf();
      if (closed || !host.current || !lib) return;
      const c = readColors();
      api = lib.createChart(host.current, {
        autoSize: true,
        layout: {
          background: { type: 'solid', color: c.bg },
          textColor: c.text,
          fontFamily: getComputedStyle(host.current).fontFamily,
          fontSize: 12,
          attributionLogo: true,
          panes: { separatorColor: c.line, separatorHoverColor: c.line, enableResize: false },
        },
        grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
        rightPriceScale: { borderColor: c.line },
        localization: { timeFormatter: (seconds: number) => axisTime(seconds, zone.current) },
        timeScale: {
          borderColor: c.line,
          timeVisible: true,
          secondsVisible: false,
          rightOffset: 6,
          tickMarkFormatter: (seconds: number, kind: number) => tickMark(seconds, kind, zone.current),
        },
        crosshair: { mode: 0 },
      });
      engine.current = lib;
      chart.current = api;
      volume.current = api.addSeries(
        lib.HistogramSeries,
        { priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false },
        1,
      );
      averages.current = MA_PERIODS.map((_, i) =>
        api!.addSeries(lib.LineSeries, {
          color: c.ma[i],
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        }),
      );
      const panes = api.panes();
      panes[0]?.setStretchFactor(3);
      panes[1]?.setStretchFactor(1);
      onMove = (param) => setHover(param.time ?? null);
      api.subscribeCrosshairMove(onMove);
      setReady((n) => n + 1);
    });
    return () => {
      closed = true;
      if (api && onMove) api.unsubscribeCrosshairMove(onMove);
      api?.remove();
      chart.current = null;
      engine.current = null;
      main.current = null;
      volume.current = null;
      averages.current = [];
      markers.current = null;
      lines.current = [];
      shown.current = null;
    };
  }, []);

  // The main series follows the mode (candles or line), recreated only when the mode changes.
  useEffect(() => {
    const lib = engine.current;
    const api = chart.current;
    if (!lib || !api) return;
    const c = readColors();
    if (main.current) api.removeSeries(main.current);
    markers.current = null;
    lines.current = [];
    shown.current = null;
    main.current =
      mode === 'line'
        ? api.addSeries(lib.LineSeries, { color: c.accent, lineWidth: 2, priceFormat: priceFormat(tickSize) })
        : api.addSeries(lib.CandlestickSeries, {
            upColor: c.up,
            downColor: c.down,
            wickUpColor: c.up,
            wickDownColor: c.down,
            borderVisible: false,
            priceFormat: priceFormat(tickSize),
          });
    // The axis follows the first series on it (the averages were added first), so they carry the price format too.
    averages.current.forEach((s) => s.applyOptions({ visible: mode === 'candles', priceFormat: priceFormat(tickSize) }));
    setReady((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, tickSize, ready === 0]);

  // Feed candles: `update` for the newest ones, a full reset only when the window moved.
  useEffect(() => {
    const series = main.current;
    const vol = volume.current;
    if (!series || !vol || candles.length === 0) return;
    const c = readColors();
    const plan = planUpdate(shown.current, candles);
    const point = (mode === 'line' ? toLinePoint : toBar) as (c: Candle) => unknown;
    const volColors = { up: c.volUp, down: c.volDown };
    if (plan.kind === 'reset') {
      series.setData(candles.map(point));
      vol.setData(candles.map((x) => toVolumeBar(x, volColors)));
      averages.current.forEach((s, i) => s.setData(movingAverage(candles, MA_PERIODS[i]!)));
      if (fittedFor.current !== resetKey) {
        chart.current?.timeScale().fitContent();
        fittedFor.current = resetKey;
      }
    } else {
      const tail = candles.slice(plan.from);
      for (const x of tail) {
        series.update(point(x));
        vol.update(toVolumeBar(x, volColors));
      }
      const since = Math.floor(tail[0]!.t / 1000);
      averages.current.forEach((s, i) => {
        for (const p of movingAverage(candles, MA_PERIODS[i]!)) if (p.time >= since) s.update(p);
      });
    }
    shown.current = candles;
  }, [candles, mode, ready, resetKey]);

  // The person's open orders as dashed price lines.
  useEffect(() => {
    const series = main.current;
    if (!series) return;
    const c = readColors();
    lines.current.forEach((line) => series.removePriceLine(line));
    lines.current = orderLines.map((order) =>
      series.createPriceLine({
        price: priceCoordinate(order.price),
        color: order.side === 'buy' ? c.up : c.down,
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: order.side === 'buy' ? labels.buy : labels.sell,
      }),
    );
  }, [orderLines, ready, labels.buy, labels.sell]);

  // B/S markers for the person's fills.
  useEffect(() => {
    const series = main.current;
    const lib = engine.current;
    if (!series || !lib) return;
    const c = readColors();
    const next = fillMarkers(
      fills,
      candles,
      stepOf(interval),
      { up: c.up, down: c.down },
      { buy: labels.buy.charAt(0), sell: labels.sell.charAt(0) },
    );
    if (markers.current) markers.current.setMarkers(next);
    else markers.current = lib.createSeriesMarkers(series, next);
  }, [fills, candles, interval, ready, labels.buy, labels.sell]);

  // "Red for up": re-read the token colours when the preference changes.
  useEffect(() => {
    const series = main.current;
    if (!series) return;
    const c = readColors();
    series.applyOptions(
      mode === 'line' ? { color: c.accent } : { upColor: c.up, downColor: c.down, wickUpColor: c.up, wickDownColor: c.down },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upColor]);

  const byTime = useMemo(() => new Map(candles.map((c) => [Math.floor(c.t / 1000), c])), [candles]);
  const focus = (hover !== null ? byTime.get(hover) : undefined) ?? candles[candles.length - 1];
  const legend = focus ? legendValues(focus, tickSize) : null;

  return (
    <div className="pc-root" role="img" aria-label={labels.chart}>
      <div ref={host} data-testid="pc-host" className="pc-host" />
      {legend && focus ? (
        <div data-testid="pc-legend" className="pc-legend" aria-hidden="true">
          <span className="pc-time">{formatTime(Math.floor(focus.t / 1000))}</span>
          <span className="pc-ohlc">
            {labels.open} <b>{legend.open}</b>
          </span>
          <span className="pc-ohlc">
            {labels.high} <b>{legend.high}</b>
          </span>
          <span className="pc-ohlc">
            {labels.low} <b>{legend.low}</b>
          </span>
          <span className="pc-ohlc">
            {labels.close} <b>{legend.close}</b>
          </span>
          <span className="pc-change" data-direction={legend.direction}>
            {labels.change} {legend.change}
          </span>
          {mode === 'candles' ? (
            <span className="pc-ma">
              {MA_PERIODS.map((p, i) => (
                <span key={p} className={`pc-ma-${i + 1}`}>
                  MA({p})
                </span>
              ))}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
