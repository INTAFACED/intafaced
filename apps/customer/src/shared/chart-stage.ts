/**
 * One Lightweight Charts chart with one main series on a room's element, and what is kept in step with it: the chart's
 * options, labelled price lines on the main series, the bars it shows and a bar brought to the middle of the view. The
 * chart is the library's own object, typed here by the few calls these hooks make, so they know no screen
 * (garden/no-effect-in-product). Each hook reads its latest arguments when it runs, so a room passes fresh closures.
 *
 * - `useChartStage`: loads the library, makes the chart on the element once per mount and passes its pointer and view
 *   range on; makes the main series again whenever `seriesKey` changes (the one before removed) and hands out a new host
 *   with it, told to `onHost` whenever it changes and `null` when the room goes.
 * - `useChartOptionsInPlace`: options applied to the chart in place whenever their key changes.
 * - `useMainSeriesLines`: labelled lines on the main series, drawn again whenever their key or the host changes.
 * - `useMainSeriesBars`: the bars on the main series: `update` for the newest, a full reset when the window moved, the
 *   view fitted once per fit key and otherwise kept on the same bars when older ones are put in front.
 * - `useCentredBar`: moves the view so an asked bar is in the middle, keeping the zoom.
 */
import { useEffect, useRef, useState, type RefObject } from 'react';

export interface LogicalRange {
  from: number;
  to: number;
}

export interface StageTimeScale {
  fitContent(): void;
  getVisibleLogicalRange(): LogicalRange | null;
  setVisibleLogicalRange(range: LogicalRange): void;
  subscribeVisibleLogicalRangeChange(handler: (range: LogicalRange | null) => void): void;
  unsubscribeVisibleLogicalRangeChange(handler: (range: LogicalRange | null) => void): void;
}

export interface StageSeries {
  setData(data: unknown[]): void;
  update(point: unknown): void;
  createPriceLine(options: Record<string, unknown>): unknown;
  removePriceLine(line: unknown): void;
}

export interface StageChart<S> {
  subscribeCrosshairMove(handler: (param: { time?: number }) => void): void;
  unsubscribeCrosshairMove(handler: (param: { time?: number }) => void): void;
  timeScale(): StageTimeScale;
  addSeries(definition: unknown, options?: Record<string, unknown>, pane?: number): S;
  removeSeries(series: S): void;
  applyOptions(options: Record<string, unknown>): void;
  remove(): void;
}

export interface ChartStageSpec<L, C, S, H> {
  /** Loads the library and returns its engine, if it published one. */
  load: () => Promise<L | undefined>;
  /** Makes the chart on the element. */
  create: (lib: L, element: HTMLElement) => C;
  onCrosshairMove: (param: { time?: number }) => void;
  /** The bars in view, as logical bar indexes, on every pan and zoom. */
  onVisibleRangeChange: (range: LogicalRange | null) => void;
  /** The main series' definition and options, read when it is made. */
  series: (lib: L) => { definition: unknown; options: Record<string, unknown> };
  /** Changes whenever the main series must be made again. */
  seriesKey: string;
  /** The host handed out with each new main series. */
  host: (lib: L, chart: C, series: S, element: HTMLElement) => H;
  onHost?: (host: H | null) => void;
}

export interface ChartStage<L, C, S, H> {
  lib: RefObject<L | null>;
  chart: RefObject<C | null>;
  main: RefObject<S | null>;
  /** True once the chart is made. */
  ready: boolean;
  /** The host for the main series shown, null before it and after the chart goes. */
  host: H | null;
}

export function useChartStage<L, C extends StageChart<S>, S, H>(
  element: RefObject<HTMLElement | null>,
  spec: ChartStageSpec<L, C, S, H>,
): ChartStage<L, C, S, H> {
  const latest = useRef(spec);
  latest.current = spec;
  const lib = useRef<L | null>(null);
  const chart = useRef<C | null>(null);
  const main = useRef<S | null>(null);
  const [ready, setReady] = useState(false);
  const [host, setHost] = useState<H | null>(null);

  // One chart per mount.
  useEffect(() => {
    let closed = false;
    let api: C | null = null;
    const onMove = (param: { time?: number }) => latest.current.onCrosshairMove(param);
    const onRange = (range: LogicalRange | null) => latest.current.onVisibleRangeChange(range);
    void latest.current.load().then((engine) => {
      if (closed || !element.current || !engine) return;
      api = latest.current.create(engine, element.current);
      lib.current = engine;
      chart.current = api;
      api.subscribeCrosshairMove(onMove);
      api.timeScale().subscribeVisibleLogicalRangeChange(onRange);
      setReady(true);
    });
    return () => {
      closed = true;
      if (api) {
        api.unsubscribeCrosshairMove(onMove);
        api.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
        api.remove();
      }
      chart.current = null;
      lib.current = null;
      main.current = null;
      setHost(null);
    };
  }, [element]);

  // The main series, made again only when its key changes.
  const { seriesKey } = spec;
  useEffect(() => {
    const engine = lib.current;
    const api = chart.current;
    if (!ready || !engine || !api || !element.current) return;
    const made = latest.current.series(engine);
    if (main.current) api.removeSeries(main.current);
    const series = api.addSeries(made.definition, made.options, 0);
    main.current = series;
    setHost(latest.current.host(engine, api, series, element.current));
  }, [ready, seriesKey, element]);

  useEffect(() => {
    latest.current.onHost?.(host);
  }, [host]);
  useEffect(() => () => latest.current.onHost?.(null), []);

  return { lib, chart, main, ready, host };
}

/** Applies `options` to the chart in place once it is made and again whenever `key` changes (it must carry every value). */
export function useChartOptionsInPlace(
  chart: RefObject<{ applyOptions(options: Record<string, unknown>): void } | null>,
  ready: boolean,
  options: Record<string, unknown>,
  key: string,
): void {
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    const api = chart.current;
    if (!ready || !api) return;
    api.applyOptions(latest.current);
  }, [chart, ready, key]);
}

/** One labelled line. `token` names the colour role (`--if-fg-2`), read from the app's theme when drawn. */
export interface SeriesLineSpec {
  price: number;
  token: string;
  lineWidth: number;
  /** The library's line style: 0 solid, 2 dashed. */
  lineStyle: number;
  title: string;
}

/**
 * Draws `lines` on the main series whenever `key` (it must carry every value the lines draw) or `host` changes. The lines
 * drawn before are removed first when they are on the same series; a new main series dropped them with the old one.
 * `onDrawn` gets the library's lines just drawn.
 */
export function useMainSeriesLines<S extends StageSeries>(
  main: RefObject<S | null>,
  host: unknown,
  lines: readonly SeriesLineSpec[],
  key: string,
  onDrawn?: (drawn: unknown[]) => void,
): void {
  const latest = useRef({ lines, onDrawn });
  latest.current = { lines, onDrawn };
  const drawn = useRef<{ series: S; lines: unknown[] } | null>(null);
  useEffect(() => {
    const series = main.current;
    if (!series) return;
    if (drawn.current && drawn.current.series === series) for (const line of drawn.current.lines) series.removePriceLine(line);
    const css = getComputedStyle(document.documentElement);
    const made = latest.current.lines.map((line) =>
      series.createPriceLine({
        price: line.price,
        color: css.getPropertyValue(line.token).trim(),
        lineWidth: line.lineWidth,
        lineStyle: line.lineStyle,
        axisLabelVisible: true,
        title: line.title,
      }),
    );
    drawn.current = { series, lines: made };
    latest.current.onDrawn?.(made);
  }, [main, host, key]);
}

export type BarsPlan = { kind: 'reset' } | { kind: 'update'; from: number };

export interface MainSeriesBars<B, S, R> {
  /** Changes whenever the bars must be drawn again with the same array (a new style, a new scale). */
  key: string;
  /** The view is fitted to the bars the first time each fit key is drawn. */
  fitKey: string;
  /** Whether the bars shown before on this series (null: none) can be updated from an index or must be set again. */
  plan: (before: readonly B[] | null, bars: readonly B[]) => BarsPlan;
  /** The series' points for the bars, one per bar, read when drawn, and what the room reports about them. */
  points: () => { points: unknown[]; report: R };
  /** After the view was fitted. */
  onFit?: () => void;
  /** After the bars are on the series. */
  onDrawn?: (series: S, report: R) => void;
}

/** Shows `bars` (oldest first, `t` in epoch ms) on the main series whenever they, the host or `spec.key` change. */
export function useMainSeriesBars<B extends { t: number }, S extends StageSeries, R>(
  chart: RefObject<{ timeScale(): StageTimeScale } | null>,
  main: RefObject<S | null>,
  host: unknown,
  bars: readonly B[],
  spec: MainSeriesBars<B, S, R>,
): void {
  const latest = useRef(spec);
  latest.current = spec;
  const shown = useRef<{ series: S; bars: readonly B[] } | null>(null);
  const fittedFor = useRef<string | null>(null);
  const { key } = spec;
  useEffect(() => {
    const series = main.current;
    const api = chart.current;
    if (!series || !api || bars.length === 0) return;
    const now = latest.current;
    // A new main series starts with nothing shown on it.
    const before = shown.current && shown.current.series === series ? shown.current.bars : null;
    const plan = now.plan(before, bars);
    const { points, report } = now.points();
    if (plan.kind === 'reset') {
      const range = api.timeScale().getVisibleLogicalRange();
      const prepended = before && before.length > 0 ? bars.findIndex((bar) => bar.t === before[0]!.t) : -1;
      series.setData(points);
      if (fittedFor.current !== now.fitKey) {
        api.timeScale().fitContent();
        fittedFor.current = now.fitKey;
        now.onFit?.();
      } else if (range && prepended > 0) {
        api.timeScale().setVisibleLogicalRange({ from: range.from + prepended, to: range.to + prepended });
      }
    } else {
      for (const point of points.slice(plan.from)) series.update(point);
    }
    shown.current = { series, bars };
    now.onDrawn?.(series, report);
  }, [chart, main, host, bars, key]);
}

/** The view's width in bars when none is shown yet, and the narrowest view a centred bar is shown in. */
const CENTRE_WIDTH_DEFAULT = 120;
const CENTRE_WIDTH_MIN = 20;

/** Moves the view so `focus.index` is in the middle, keeping the zoom, whenever a new `focus` is asked for. */
export function useCentredBar(
  chart: RefObject<{ timeScale(): StageTimeScale } | null>,
  focus: { index: number; nonce: number } | null | undefined,
): void {
  useEffect(() => {
    const api = chart.current;
    if (!focus || !api) return;
    const range = api.timeScale().getVisibleLogicalRange();
    const width = range ? Math.max(CENTRE_WIDTH_MIN, range.to - range.from) : CENTRE_WIDTH_DEFAULT;
    api.timeScale().setVisibleLogicalRange({ from: focus.index - width / 2, to: focus.index + width / 2 });
  }, [chart, focus]);
}
