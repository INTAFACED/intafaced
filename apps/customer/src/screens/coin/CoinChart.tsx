/**
 * The coin page's price line (UI-SPEC 5.5): one line, coloured by the range's direction, no grid, no price axis, a
 * "High" and "Low" label on the line, and a crosshair that reports the candle under it to the page so the header can
 * show that price (Robinhood style).
 *
 * It draws with the same vendored Lightweight Charts 5.2.1 as the desk's `PriceChart` and shares its helpers
 * (`chart-data.ts`: candle to point, in-place updates, price format; the axis time formatters). It is not
 * `PriceChart` itself because that adapter always carries a volume pane, moving averages, a grid and an OHLC legend
 * and has no crosshair callback. Folding this in as a `PriceChart` variant is a request in the report.
 *
 * This file and `chart-data.ts` are the only places where decimal strings become JS numbers, because a canvas needs
 * coordinates (UI-SPEC principle 5). Every figure shown as text comes from the decimal strings.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { usePreferences } from '../../shared/preferences';
import { planUpdate, priceFormat, toLinePoint } from '../trade/chart/chart-data';
import { axisTime, tickMark } from '../trade/chart/PriceChart';
import { fmtPrice, type Candle } from './deps';
import { highLow, type Direction } from './coin-math';

interface SeriesApi {
  setData(data: unknown[]): void;
  update(point: unknown): void;
  applyOptions(options: Record<string, unknown>): void;
}
interface CrosshairParam {
  time?: number;
}
interface ChartApiLike {
  addSeries(definition: unknown, options?: Record<string, unknown>): SeriesApi;
  remove(): void;
  applyOptions(options: Record<string, unknown>): void;
  timeScale(): {
    fitContent(): void;
    setVisibleLogicalRange(range: { from: number; to: number }): void;
  };
  subscribeCrosshairMove(handler: (param: CrosshairParam) => void): void;
  unsubscribeCrosshairMove(handler: (param: CrosshairParam) => void): void;
}
/** Pixels kept free left of the first candle: a High or Low label on it is centred there, and half of it would be cut off. */
const LEFT_ROOM_PX = 40;
/** Must match the time scale's `rightOffset` below. */
const RIGHT_OFFSET_BARS = 8;

interface Marker {
  time: number;
  position: 'aboveBar' | 'belowBar';
  shape: 'circle';
  size: number;
  color: string;
  text: string;
}
interface Engine {
  createChart(host: HTMLElement, options: Record<string, unknown>): ChartApiLike;
  LineSeries: unknown;
  createSeriesMarkers(series: SeriesApi, markers: Marker[]): { setMarkers(markers: Marker[]): void };
}
const engineOf = (): Engine | undefined => (window as unknown as { LightweightCharts?: Engine }).LightweightCharts;

function readColors() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    panel: v('--if-panel'),
    text: v('--if-fg-2'),
    line: v('--if-line-stronger'),
    label: v('--if-pill-active'),
    fg: v('--if-fg'),
    up: v('--if-up-text'),
    down: v('--if-down-text'),
  };
}

export interface CoinChartProps {
  candles: readonly Candle[];
  /** Changes when the market or range changes: the line is fitted again. */
  resetKey: string;
  tickSize: string;
  /** Colours the line: green for up (or flat), red for down, by the "red for up" setting. */
  direction: Direction;
  /** IANA zone, or undefined for the device's own. */
  timeZone: string | undefined;
  /** Accessible name of the chart. */
  label: string;
  /** The candle under the crosshair, or null when it leaves. */
  onScrub: (candle: Candle | null) => void;
}

export function CoinChart({ candles, resetKey, tickSize, direction, timeZone, label, onScrub }: CoinChartProps) {
  const { upColor } = usePreferences();
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<Engine | null>(null);
  const chart = useRef<ChartApiLike | null>(null);
  const line = useRef<SeriesApi | null>(null);
  const markers = useRef<{ setMarkers(markers: Marker[]): void } | null>(null);
  const shown = useRef<readonly Candle[] | null>(null);
  const fittedFor = useRef<string | null>(null);
  const [ready, setReady] = useState(false);

  // The chart is created once and its callbacks read the latest values from here.
  // Times are drawn "14 Oct, 02:15" like every other time on the page (en-GB order), in the person's zone.
  const zone = { language: 'en-GB', timeZone };
  const latest = useRef({ candles, onScrub, zone });
  latest.current = { candles, onScrub, zone };
  const byTime = useMemo(() => new Map(candles.map((c) => [Math.floor(c.t / 1000), c])), [candles]);
  const lookup = useRef(byTime);
  lookup.current = byTime;

  useEffect(() => {
    let closed = false;
    let api: ChartApiLike | null = null;
    let onMove: ((param: CrosshairParam) => void) | null = null;
    void import('../../features/trade/vendor/lightweight-charts.standalone.production.js').then(() => {
      const lib = engineOf();
      if (closed || !host.current || !lib) return;
      const c = readColors();
      api = lib.createChart(host.current, {
        autoSize: true,
        handleScroll: false,
        handleScale: false,
        layout: {
          background: { type: 'solid', color: c.panel },
          textColor: c.text,
          fontFamily: getComputedStyle(host.current).fontFamily,
          fontSize: 12,
          attributionLogo: true,
        },
        grid: { vertLines: { visible: false }, horzLines: { visible: false } },
        leftPriceScale: { visible: false },
        rightPriceScale: { visible: false, scaleMargins: { top: 0.2, bottom: 0.1 } },
        localization: { timeFormatter: (seconds: number) => axisTime(seconds, latest.current.zone) },
        timeScale: {
          borderVisible: false,
          timeVisible: true,
          secondsVisible: false,
          // Not fixed: the fit below leaves a little empty space on the left, so a label on the first candle fits.
          fixLeftEdge: false,
          // Room on the right so a High or Low label near the latest price is not cut off at the edge.
          fixRightEdge: false,
          rightOffset: RIGHT_OFFSET_BARS,
          tickMarkFormatter: (seconds: number, kind: number) => tickMark(seconds, kind, latest.current.zone),
        },
        crosshair: {
          mode: 1,
          vertLine: { color: c.line, width: 1, style: 2, labelBackgroundColor: c.label },
          horzLine: { visible: false, labelVisible: false },
        },
      });
      line.current = api.addSeries(lib.LineSeries, {
        color: c.up,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerRadius: 4,
        priceFormat: priceFormat(tickSize),
      });
      onMove = (param) => {
        const candle = param.time === undefined ? undefined : lookup.current.get(param.time);
        latest.current.onScrub(candle ?? null);
      };
      api.subscribeCrosshairMove(onMove);
      engine.current = lib;
      chart.current = api;
      setReady(true);
    });
    return () => {
      closed = true;
      if (api && onMove) api.unsubscribeCrosshairMove(onMove);
      api?.remove();
      chart.current = null;
      engine.current = null;
      line.current = null;
      markers.current = null;
      shown.current = null;
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The tick size can change when the quote does.
  useEffect(() => {
    line.current?.applyOptions({ priceFormat: priceFormat(tickSize) });
  }, [tickSize, ready]);

  // Colour: green or red by the range's direction, and again when "red for up" is switched.
  useEffect(() => {
    if (!line.current) return;
    const c = readColors();
    line.current.applyOptions({ color: direction === 'down' ? c.down : c.up });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [direction, upColor, ready]);

  // Candles: `update` for the newest ones, a full reset only when the window moved.
  useEffect(() => {
    const series = line.current;
    if (!series || candles.length === 0) return;
    const plan = planUpdate(shown.current, candles);
    if (plan.kind === 'reset') {
      series.setData(candles.map(toLinePoint));
      if (fittedFor.current !== resetKey) {
        const scale = chart.current?.timeScale();
        const width = host.current?.clientWidth ?? 0;
        if (scale && width > LEFT_ROOM_PX * 2 && candles.length > 1) {
          // All candles plus the right offset, with LEFT_ROOM_PX of empty space before the first one.
          const span = candles.length - 1 + RIGHT_OFFSET_BARS;
          scale.setVisibleLogicalRange({ from: -(LEFT_ROOM_PX * span) / (width - LEFT_ROOM_PX), to: span });
        } else scale?.fitContent();
        fittedFor.current = resetKey;
      }
    } else {
      for (const candle of candles.slice(plan.from)) series.update(toLinePoint(candle));
    }
    shown.current = candles;
  }, [candles, resetKey, ready]);

  // "High" and "Low" labels: invisible dots on the two extreme closes, named with their prices.
  useEffect(() => {
    const series = line.current;
    const lib = engine.current;
    if (!series || !lib) return;
    const c = readColors();
    const extremes = highLow(candles);
    const next: Marker[] = extremes
      ? [
          { at: extremes.high, position: 'aboveBar' as const },
          { at: extremes.low, position: 'belowBar' as const },
        ]
          .map(({ at, position }) => ({
            time: Math.floor(candles[at.index]!.t / 1000),
            position,
            shape: 'circle' as const,
            size: 0,
            color: c.text,
            text: `$${fmtPrice(at.price, tickSize)}`,
          }))
          .sort((a, b) => a.time - b.time)
      : [];
    if (markers.current) markers.current.setMarkers(next);
    else markers.current = lib.createSeriesMarkers(series, next);
  }, [candles, tickSize, ready]);

  return (
    <div data-testid="coin-chart" className="coin-chart" role="img" aria-label={label}>
      <div ref={host} data-testid="coin-chart__host" className="coin-chart__host" />
    </div>
  );
}
