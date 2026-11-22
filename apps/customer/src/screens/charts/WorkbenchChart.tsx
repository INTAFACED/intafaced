/**
 * WorkbenchChart: the chart workbench's own adapter to the vendored Lightweight Charts 5.2.1 (`features/trade/vendor`,
 * Apache-2.0, notice kept beside the file). The desk keeps `trade/chart/PriceChart`; this one draws every chart style,
 * the colour scheme, older history in front of the loaded bars, a moved view for "go to date", keyboard zoom and pan,
 * and hands a `ChartHost` to the add-ons drawn on top (studies, drawings).
 *
 * TradingView attribution stays, as the licence asks, but drawn by us beside the plot rather than by the engine inside
 * it: the plot host is an image (role="img"), and an image may hold no link. So the engine's own logo is off
 * (`layout.attributionLogo: false`) and `ChartAttribution` draws the same words and link next to it, in every chart.
 * Colours come from the app's tokens (`--if-*`), never from literals here.
 */
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useCentredBar, useChartOptionsInPlace, useChartStage, useMainSeriesBars, useMainSeriesLines } from '../../shared/chart-stage';
import { chartValue } from '../../shared/chart-value';
import { usePreferences } from '../../shared/preferences';
import type { Candle } from '../../data/types';
import { legendValues, planUpdate, priceFormat } from '../trade/chart/chart-data';
import { axisTime, tickMark } from '../trade/chart/PriceChart';
import type { ChartApi, ChartHost, ChartLib, ChartSeries } from './chart-host';
import { viewKeys } from './chart-keys';
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

/**
 * What the drawing library itself holds, written on the chart's element: the series type it draws, the bars it was
 * given (count, first and last time in epoch ms, like data-first and data-last; the library's own unit is seconds),
 * the up and down colours of a series that has them (candles and bars), its price format, and the background.
 * Read back from the library, not from props, so a check on them is a check on the drawing.
 */
function writeDrawn(element: HTMLElement | null, chart: ChartApi | null, series: ChartSeries | null) {
  if (!element || !chart || !series) return;
  const options = series.options() as {
    upColor?: string;
    downColor?: string;
    priceFormat?: { minMove?: number; formatter?: (price: number) => string };
  };
  const data = series.data() as ReadonlyArray<{ time: number }>;
  const layout = (chart.options() as { layout?: { background?: { color?: string } } }).layout;
  const values: Record<string, string> = {
    'data-drawn': series.seriesType(),
    'data-drawn-bars': String(data.length),
    'data-drawn-first': data.length > 0 ? String(data[0]!.time * 1000) : '',
    'data-drawn-last': data.length > 0 ? String(data[data.length - 1]!.time * 1000) : '',
    'data-drawn-up': options.upColor ?? '',
    'data-drawn-down': options.downColor ?? '',
    'data-drawn-bg': layout?.background?.color ?? '',
    // The axis writes every price through this formatter: zero shows its decimals ("0.00" for a 0.01 tick).
    'data-drawn-format': options.priceFormat?.formatter ? options.priceFormat.formatter(0) : '',
    'data-drawn-min-move': options.priceFormat?.minMove === undefined ? '' : String(options.priceFormat.minMove),
  };
  for (const [name, value] of Object.entries(values)) element.setAttribute(name, value);
}

export interface WorkbenchChartProps {
  candles: readonly Candle[];
  chartStyle: ChartStyle;
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

const NO_LINES: readonly PriceLine[] = [];

/** The engine's own attribution, as its vendored file draws it: the logo's title and the link it opens. */
export const ATTRIBUTION_WORDS = 'Charting by TradingView';
const ATTRIBUTION_LINK = 'https://www.tradingview.com/?utm_medium=lwc-link&utm_campaign=lwc-chart';

/** The link the engine's logo opens: its address, with the page it sits on as the source, exactly as the engine adds it. */
export function attributionHref(page: { hostname: string; pathname: string }): string {
  return page.hostname ? `${ATTRIBUTION_LINK}&utm_source=${page.hostname}${page.pathname}` : ATTRIBUTION_LINK;
}

/** The chart's attribution, a visible link beside the plot and outside its image. */
export function ChartAttribution() {
  return (
    <a
      data-testid="wc-attribution"
      className="lt-link lt-chart-attribution"
      href={attributionHref(window.location)}
      target="_blank"
      rel="noopener noreferrer"
    >
      {ATTRIBUTION_WORDS}
    </a>
  );
}

export function WorkbenchChart({
  candles,
  chartStyle: style,
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
  const reachStart = useRef(onReachStart);
  reachStart.current = onReachStart;
  const count = useRef(0);
  count.current = candles.length;
  // Older bars are asked for only once the person moves the chart, never by the chart's own fit on open.
  const moved = useRef(false);
  // The view keys, which start a key pressed before the chart has drawn the last one from the range that one asked for.
  const [viewKey] = useState(() => viewKeys((run) => void requestAnimationFrame(run)));
  const [hover, setHover] = useState<number | null>(null);
  /** What percent mode reports: the base the prices are rebased to, and the first drawn value (0.00 when rebased). */
  const [rebase, setRebase] = useState({ base: '', first: '' });
  const zone = useRef({ language, timeZone });
  zone.current = { language, timeZone };

  // One chart per mount; the main series follows the style, scheme and percent mode, made again only when one of them
  // changes, and the host handed out with it is told to `onHost` (null when the chart goes).
  const stage = useChartStage<Engine, ChartApi, ChartSeries, ChartHost>(element, {
    // Without the kit's stylesheet the colour tokens are empty and the engine refuses an empty colour: draw nothing.
    load: () =>
      import('../../features/trade/vendor/lightweight-charts.standalone.production.js').then(() =>
        readColors('standard').bg ? engineOf() : undefined,
      ),
    create: (lib, el) => {
      const c = readColors('standard');
      return lib.createChart(el, {
        autoSize: true,
        layout: {
          background: { type: 'solid', color: c.bg },
          textColor: c.text,
          fontFamily: getComputedStyle(el).fontFamily,
          fontSize: 12,
          attributionLogo: false,
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
    },
    onCrosshairMove: (param) => setHover(param.time ?? null),
    onVisibleRangeChange: (range) => {
      // The bars in view, as logical bar indexes (0 is the first loaded bar), so a zoom or a pan can be read back.
      // Written here rather than rendered, so a pan or zoom doesn't re-render the chart each frame; no range, no attribute.
      for (const [name, value] of [
        ['data-view-from', range?.from],
        ['data-view-to', range?.to],
      ] as const) {
        if (value === undefined) element.current?.removeAttribute(name);
        else element.current?.setAttribute(name, String(value));
      }
      if (moved.current && range && count.current > 0 && range.from < 5) reachStart.current?.();
    },
    series: (lib) => {
      const colors = readColors(scheme).series;
      const format = percent ? PERCENT_PRICE_FORMAT : priceFormat(tickSize, language);
      return { definition: lib[SERIES_KIND[style]], options: { ...seriesOptions(style, colors), priceFormat: format } };
    },
    // `upColor` ("red for up") changes the token values, so the series is drawn again with them.
    seriesKey: JSON.stringify([style, scheme, tickSize, symbol, upColor, percent, language]),
    host: (lib, api, series, el) => ({ lib, chart: api, main: series, element: el, tickSize, symbol }),
    onHost,
  });
  const { host } = stage;

  // Scales and canvas: applied to the chart in place, so a change never rebuilds the series or moves the view. Log scale
  // is not drawn with percent mode, which has its own scale.
  const { priceScale, timeScale: timeScaleOn, logScale, gridLines } = settings;
  useChartOptionsInPlace(
    stage.chart,
    stage.ready,
    {
      rightPriceScale: { visible: priceScale, mode: logScale && !percent ? 1 : 0 },
      timeScale: { visible: timeScaleOn },
      grid: { vertLines: { visible: gridLines }, horzLines: { visible: gridLines } },
    },
    JSON.stringify([priceScale, timeScaleOn, logScale, gridLines, percent]),
  );

  // Price lines: one labelled line per overlay, drawn on the main series at its exact price. A new main series (a new
  // style or scheme) drops the old lines with it, so they are drawn again on the series that is shown.
  const lineKey = priceLines.map((line) => `${line.price}|${line.label}`).join(',');
  useMainSeriesLines(
    stage.main,
    host,
    priceLines.map((line) => ({ price: chartValue(line.price), token: '--if-fg-2', lineWidth: 1, lineStyle: 2, title: line.label })),
    lineKey,
    (lines) =>
      // What the library holds for each drawn line, read back from the line itself, not from props: "<price>|<title>",
      // lines separated by a newline, so a check on it is a check on the drawing.
      element.current?.setAttribute(
        'data-drawn-price-lines',
        lines
          .map((line) => (line as { options?: () => { price?: number; title?: string } }).options?.())
          .map((options) => (options ? `${options.price ?? ''}|${options.title ?? ''}` : ''))
          .join('\n'),
      ),
  );

  // Feed candles: `update` for the newest ones; a full reset when the window moved, keeping the view on the same bars
  // when older history was put in front.
  useMainSeriesBars(stage.chart, stage.main, host, candles, {
    key: JSON.stringify([style, scheme, resetKey, percent]),
    fitKey: resetKey,
    // Heikin Ashi and percent mode redraw every point: a percent base can move with the first bar it is taken from.
    plan: (before, bars) => (style === 'heikin-ashi' || percent ? { kind: 'reset' } : planUpdate(before, bars)),
    points: () => {
      const colors = readColors(scheme).series;
      const drawn = seriesPoints(style, candles, colors) as DrawnPoint[];
      const base = percentBase(drawn);
      return { points: percent ? (base === null ? [] : rebasePoints(drawn, base)) : drawn, report: base };
    },
    onFit: () => {
      moved.current = false;
    },
    onDrawn: (series, base) => {
      // What the library holds for the first bar, read back from the series itself.
      const at = series.dataByIndex(0) as Partial<Record<'close' | 'value', number>> | null;
      const first = at ? (at.close ?? at.value) : undefined;
      // After the bars are set, so the readback never shows a new series before its data.
      writeDrawn(element.current, stage.chart.current, series);
      setRebase({
        base: percent && base !== null ? String(base) : '',
        first: percent && typeof first === 'number' ? first.toFixed(2) : '',
      });
    },
  });

  // Go to date: centre the asked bar, keeping the current zoom. Only a new ask moves the view; a new series (style,
  // scheme) keeps where the person is.
  useCentredBar(stage.chart, focus);

  /** Keyboard: arrows pan by ten bars, + and - zoom around the right edge, Home shows the newest bars again (chart-keys.ts). */
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    moved.current = true;
    const scale = stage.chart.current?.timeScale();
    if (scale && viewKey(scale, event.key)) event.preventDefault();
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
  const legend = focusBar ? legendValues(focusBar, tickSize, language) : null;

  return (
    <div className="lt-chart-stack">
      <div className="lt-chart-stage">
        <div
          ref={element}
          data-testid="wc-host"
          className="lt-chart-host"
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
          <div className="lt-chart-legend lt-num" data-testid="chart-legend">
            {settings.showTime && <span data-testid="wc-time">{formatTime(Math.floor(focusBar.t / 1000))}</span>}
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
              <span className="lt-signed" data-direction={legend.direction}>
                {labels.change} {legend.change}
              </span>
            )}
          </div>
        ) : null}
      </div>
      <ChartAttribution />
      {children?.(host, candles)}
    </div>
  );
}
