/**
 * WorkbenchChart: the chart workbench's own adapter to the vendored Lightweight Charts 5.2.1 (`features/trade/vendor`,
 * Apache-2.0, notice kept beside the file). The desk keeps `trade/chart/PriceChart`; this one draws every chart style,
 * the colour scheme, older history in front of the loaded bars, a moved view for "go to date", keyboard zoom and pan,
 * and hands a `ChartHost` to the add-ons drawn on top (studies, drawings).
 *
 * TradingView attribution stays on (`layout.attributionLogo: true`), as the licence asks. Colours come from the app's
 * tokens (`--if-*`), never from literals here.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { usePreferences } from '../../shared/preferences';
import type { Candle } from '../../data/types';
import { legendValues, planUpdate, priceFormat } from '../trade/chart/chart-data';
import { axisTime, tickMark } from '../trade/chart/PriceChart';
import type { ChartApi, ChartHost, ChartLib, ChartSeries } from './chart-host';
import { DEFAULT_CHART_SETTINGS, type ChartSettings } from './chart-settings';
import type { PriceLine } from './price-lines';
import {
  PERCENT_PRICE_FORMAT,
  SCHEME_TOKENS,
  SERIES_KIND,
  percentBase,
  rebasePoints,
  seriesOptions,
  seriesPoints,
  type ChartStyle,
  type ColourScheme,
  type DrawnPoint,
  type SchemeColors,
} from './chart-style';

type Engine = ChartLib & { createChart(host: HTMLElement, options: Record<string, unknown>): ChartApi } & Record<string, unknown>;
const engineOf = (): Engine | undefined => (window as unknown as { LightweightCharts?: Engine }).LightweightCharts;

function readColors(scheme: ColourScheme) {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  const tokens = SCHEME_TOKENS[scheme];
  return {
    bg: v('--if-bg'),
    text: v('--if-fg-2'),
    grid: v('--if-grid'),
    border: v('--if-line'),
    series: { up: v(tokens.up), down: v(tokens.down), line: v(tokens.line) } satisfies SchemeColors,
  };
}

export interface WorkbenchChartProps {
  candles: readonly Candle[];
  style: ChartStyle;
  scheme: ColourScheme;
  /** Changes with the market or interval: the view is fitted again; otherwise it stays where the person put it. */
  resetKey: string;
  symbol: string;
  tickSize: string;
  timeZone: string | undefined;
  labels: { open: string; high: string; low: string; close: string; change: string; chart: string; keys: string };
  /** Called when the person scrolls to the oldest loaded bar. */
  onReachStart?: () => void;
  /** Percent mode: every price is drawn as percent change from the first loaded bar (the base the chart reports). */
  percent?: boolean;
  /** Move the view so this bar index is in the middle; `nonce` makes the same index move it again. */
  focus?: { index: number; nonce: number } | null;
  /** Add-ons drawn on top of the chart (studies, drawings), given the host once the chart exists. */
  children?: (host: ChartHost | null, bars: readonly Candle[]) => ReactNode;
  /** Told the host whenever it changes (null when the chart goes), so a grid can link charts. */
  onHost?: (host: ChartHost | null) => void;
  /** The chart settings this device keeps: scales, canvas and which legend parts show. */
  settings?: ChartSettings;
  /** Price-line overlays: a labelled line at each price, on the main series. */
  priceLines?: readonly PriceLine[];
}

const PAN_BARS = 10;
const NO_LINES: readonly PriceLine[] = [];

export function WorkbenchChart({
  candles,
  style,
  scheme,
  resetKey,
  symbol,
  tickSize,
  timeZone,
  labels,
  onReachStart,
  percent = false,
  focus,
  children,
  onHost,
  settings = DEFAULT_CHART_SETTINGS,
  priceLines = NO_LINES,
}: WorkbenchChartProps) {
  const { language, upColor } = usePreferences();
  const element = useRef<HTMLDivElement>(null);
  const engine = useRef<Engine | null>(null);
  const chart = useRef<ChartApi | null>(null);
  const main = useRef<ChartSeries | null>(null);
  const shown = useRef<readonly Candle[] | null>(null);
  const fittedFor = useRef<string | null>(null);
  const reachStart = useRef(onReachStart);
  reachStart.current = onReachStart;
  const count = useRef(0);
  count.current = candles.length;
  // Older bars are asked for only once the person moves the chart, never by the chart's own fit on open.
  const moved = useRef(false);
  const [host, setHost] = useState<ChartHost | null>(null);
  const [mounted, setMounted] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  /** What percent mode reports: the base the prices are rebased to, and the first drawn value (0.00 when rebased). */
  const [rebase, setRebase] = useState({ base: '', first: '' });
  const zone = useRef({ language, timeZone });
  zone.current = { language, timeZone };

  // One chart per mount.
  useEffect(() => {
    let closed = false;
    let api: ChartApi | null = null;
    const onMove = (param: { time?: number }) => setHover(param.time ?? null);
    const onRange = (range: { from: number; to: number } | null) => {
      if (moved.current && range && count.current > 0 && range.from < 5) reachStart.current?.();
    };
    void import('../../features/trade/vendor/lightweight-charts.standalone.production.js').then(() => {
      const lib = engineOf();
      if (closed || !element.current || !lib) return;
      const c = readColors('standard');
      api = lib.createChart(element.current, {
        autoSize: true,
        layout: {
          background: { type: 'solid', color: c.bg },
          textColor: c.text,
          fontFamily: getComputedStyle(element.current).fontFamily,
          fontSize: 12,
          attributionLogo: true,
          panes: { separatorColor: c.border, separatorHoverColor: c.border, enableResize: true },
        },
        grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
        rightPriceScale: { borderColor: c.border },
        localization: { timeFormatter: (seconds: number) => axisTime(seconds, zone.current) },
        timeScale: {
          borderColor: c.border,
          timeVisible: true,
          secondsVisible: false,
          rightOffset: 6,
          tickMarkFormatter: (seconds: number, kind: number) => tickMark(seconds, kind, zone.current),
        },
        crosshair: { mode: 0 },
      });
      engine.current = lib;
      chart.current = api;
      api.subscribeCrosshairMove(onMove);
      api.timeScale().subscribeVisibleLogicalRangeChange(onRange);
      setMounted(true);
    });
    return () => {
      closed = true;
      if (api) {
        api.unsubscribeCrosshairMove(onMove);
        api.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
        api.remove();
      }
      chart.current = null;
      engine.current = null;
      main.current = null;
      shown.current = null;
      setHost(null);
    };
  }, []);

  // The main series follows the style, scheme and percent mode; recreated only when one of them changes.
  useEffect(() => {
    const lib = engine.current;
    const api = chart.current;
    if (!mounted || !lib || !api || !element.current) return;
    const colors = readColors(scheme).series;
    if (main.current) api.removeSeries(main.current);
    shown.current = null;
    const format = percent ? PERCENT_PRICE_FORMAT : priceFormat(tickSize);
    const series = api.addSeries(lib[SERIES_KIND[style]], { ...seriesOptions(style, colors), priceFormat: format }, 0);
    main.current = series;
    setHost({ lib, chart: api, main: series, element: element.current, tickSize, symbol });
    // `upColor` ("red for up") changes the token values, so the series is drawn again with them.
  }, [mounted, style, scheme, tickSize, symbol, upColor, percent]);

  // Scales and canvas: applied to the chart in place, so a change never rebuilds the series or moves the view. Log scale
  // is not drawn with percent mode, which has its own scale.
  const { priceScale, timeScale: timeScaleOn, logScale, gridLines } = settings;
  useEffect(() => {
    const api = chart.current;
    if (!mounted || !api) return;
    api.applyOptions({
      rightPriceScale: { visible: priceScale, mode: logScale && !percent ? 1 : 0 },
      timeScale: { visible: timeScaleOn },
      grid: { vertLines: { visible: gridLines }, horzLines: { visible: gridLines } },
    });
  }, [mounted, priceScale, timeScaleOn, logScale, gridLines, percent]);

  // Price lines: one labelled line per overlay, drawn on the main series at its exact price. A new main series (a new
  // style or scheme) drops the old lines with it, so they are drawn again on the series that is shown.
  const lineKey = priceLines.map((line) => `${line.price}|${line.label}`).join(',');
  const drawn = useRef<{ series: ChartSeries; lines: unknown[] } | null>(null);
  useEffect(() => {
    const series = main.current;
    if (!series) return;
    if (drawn.current && drawn.current.series === series) for (const line of drawn.current.lines) series.removePriceLine(line);
    const colour = readColors(scheme).text;
    const lines = priceLines.map((line) =>
      series.createPriceLine({
        price: Number(line.price),
        color: colour,
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: line.label,
      }),
    );
    drawn.current = { series, lines };
    // The key carries the lines' values; the series is the one the host hands out.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, lineKey]);

  // Feed candles: `update` for the newest ones; a full reset when the window moved, keeping the view on the same bars
  // when older history was put in front.
  useEffect(() => {
    const series = main.current;
    const api = chart.current;
    if (!series || !api || candles.length === 0) return;
    const colors = readColors(scheme).series;
    const before = shown.current;
    // Heikin Ashi and percent mode redraw every point: a percent base can move with the first bar it is taken from.
    const plan = style === 'heikin-ashi' || percent ? ({ kind: 'reset' } as const) : planUpdate(before, candles);
    const drawn = seriesPoints(style, candles, colors) as DrawnPoint[];
    const base = percentBase(drawn);
    const points = percent ? (base === null ? [] : rebasePoints(drawn, base)) : drawn;
    if (plan.kind === 'reset') {
      const range = api.timeScale().getVisibleLogicalRange();
      const prepended = before && before.length > 0 ? candles.findIndex((c) => c.t === before[0]!.t) : -1;
      series.setData(points);
      if (fittedFor.current !== resetKey) {
        api.timeScale().fitContent();
        fittedFor.current = resetKey;
        moved.current = false;
      } else if (range && prepended > 0) {
        api.timeScale().setVisibleLogicalRange({ from: range.from + prepended, to: range.to + prepended });
      }
    } else {
      for (const point of points.slice(plan.from)) series.update(point);
    }
    shown.current = candles;
    // What the library holds for the first bar, read back from the series itself.
    const at = series.dataByIndex(0) as Partial<Record<'close' | 'value', number>> | null;
    const first = at ? (at.close ?? at.value) : undefined;
    setRebase({
      base: percent && base !== null ? String(base) : '',
      first: percent && typeof first === 'number' ? first.toFixed(2) : '',
    });
  }, [candles, style, scheme, host, resetKey, percent]);

  const report = useRef(onHost);
  report.current = onHost;
  useEffect(() => {
    report.current?.(host);
  }, [host]);
  useEffect(() => () => report.current?.(null), []);

  // Go to date: centre the asked bar, keeping the current zoom.
  useEffect(() => {
    const api = chart.current;
    if (!focus || !api) return;
    const range = api.timeScale().getVisibleLogicalRange();
    const width = range ? Math.max(20, range.to - range.from) : 120;
    api.timeScale().setVisibleLogicalRange({ from: focus.index - width / 2, to: focus.index + width / 2 });
    // Only a new ask moves the view; a new series (style, scheme) keeps where the person is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  /** Keyboard: arrows pan by ten bars, + and - zoom around the right edge, Home shows the newest bars again. */
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    moved.current = true;
    const scale = chart.current?.timeScale();
    const range = scale?.getVisibleLogicalRange();
    if (!scale || !range) return;
    const width = range.to - range.from;
    let next: { from: number; to: number } | null = null;
    if (event.key === 'ArrowLeft') next = { from: range.from - PAN_BARS, to: range.to - PAN_BARS };
    else if (event.key === 'ArrowRight') next = { from: range.from + PAN_BARS, to: range.to + PAN_BARS };
    else if (event.key === '+' || event.key === '=') next = { from: range.to - Math.max(10, width * 0.8), to: range.to };
    else if (event.key === '-' || event.key === '_') next = { from: range.to - width * 1.25, to: range.to };
    else if (event.key === 'Home') {
      scale.fitContent();
      event.preventDefault();
      return;
    }
    if (!next) return;
    event.preventDefault();
    scale.setVisibleLogicalRange(next);
  };

  const formatTime = useMemo(
    () => (seconds: number) =>
      new Intl.DateTimeFormat(language === 'en' ? 'en-GB' : language, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        ...(timeZone ? { timeZone } : {}),
      }).format(seconds * 1000),
    [language, timeZone],
  );
  const byTime = useMemo(() => new Map(candles.map((c) => [Math.floor(c.t / 1000), c])), [candles]);
  const focusBar = (hover !== null ? byTime.get(hover) : undefined) ?? candles[candles.length - 1];
  const legend = focusBar ? legendValues(focusBar, tickSize) : null;

  return (
    <div className="wc-root">
      <div className="wc-stage">
        <div
          ref={element}
          data-testid="wc-host"
          className="wc-host"
          role="img"
          tabIndex={0}
          aria-label={labels.chart}
          aria-description={labels.keys}
          data-style={style}
          data-scheme={scheme}
          data-scale={percent ? 'percent' : 'price'}
          data-base={rebase.base}
          data-first-percent={rebase.first}
          data-bars={candles.length}
          data-price-lines={priceLines.map((line) => line.price).join(' ')}
          data-log={logScale && !percent ? 'on' : 'off'}
          data-grid={gridLines ? 'on' : 'off'}
          data-first={candles[0] ? String(candles[0].t) : ''}
          data-last={candles.length > 0 ? String(candles[candles.length - 1]!.t) : ''}
          onKeyDown={onKey}
          onPointerDown={() => (moved.current = true)}
          onWheel={() => (moved.current = true)}
        />
        {legend && focusBar ? (
          <div className="wc-legend" data-testid="chart-legend">
            {settings.showTime && (
              <span data-testid="wc-time" className="wc-time">
                {formatTime(Math.floor(focusBar.t / 1000))}
              </span>
            )}
            <span>
              {labels.open} <b>{legend.open}</b>
            </span>
            <span>
              {labels.high} <b>{legend.high}</b>
            </span>
            <span>
              {labels.low} <b>{legend.low}</b>
            </span>
            <span>
              {labels.close} <b>{legend.close}</b>
            </span>
            {settings.showChange && (
              <span className="wc-change" data-direction={legend.direction}>
                {labels.change} {legend.change}
              </span>
            )}
          </div>
        ) : null}
      </div>
      {children?.(host, candles)}
    </div>
  );
}
