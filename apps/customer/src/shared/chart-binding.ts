/**
 * Binding a Lightweight Charts chart to a room's element, kept in step with what the room shows. The chart is the
 * library's own object, typed by the caller; these hooks know no screen (garden/no-effect-in-product).
 *
 * - `useRestart`: a number that changes whenever one of `values` changes (compared with `Object.is`), for the hooks
 *   below, which start again when it does.
 * - `useChartBinding`: loads the library's bundle and builds the chart on the element behind `host` while `ready()`;
 *   built again whenever `restart` changes, and removed (after `teardown`) when it does and when the room goes.
 *   `restyle` runs once at start and again whenever `style` changes, on whatever chart is there.
 * - `useSeriesPriceLines`: price lines on a series, all removed and drawn again whenever `restart` changes; the drawn
 *   lines are held in the caller's `held` ref, which the caller empties when it builds a new chart.
 */
import { useEffect, useRef, type RefObject } from 'react';

/** A number that changes whenever one of `values` changes (compared with `Object.is`). */
export function useRestart(values: readonly unknown[]): number {
  const held = useRef<{ values: readonly unknown[]; generation: number } | null>(null);
  const previous = held.current;
  if (!previous || previous.values.length !== values.length || values.some((value, index) => !Object.is(value, previous.values[index])))
    held.current = { values, generation: (previous?.generation ?? 0) + 1 };
  return held.current!.generation;
}

/** The chart being built: `chart` is set by `build` as soon as the library made it, `closed` once it is torn down. */
export interface ChartSession<C> {
  chart: C | null;
  closed: boolean;
}

export interface ChartBinding<E, C extends { remove(): void }> {
  /** Imports the library's bundle, which publishes the engine. */
  load: () => Promise<unknown>;
  /** The engine the bundle published, if it has. */
  engine: () => E | undefined;
  /** Whether to build at all, read when the binding starts. */
  ready: () => boolean;
  /** Whether the room still wants this build, read when the bundle arrives. */
  admit: () => boolean;
  /** Builds the chart on `element`, setting `session.chart` as soon as the library made it. */
  build: (engine: E, element: HTMLElement, session: ChartSession<C>) => void;
  /** Runs on a restart and when the room goes, before the chart (if any was made) is removed. */
  teardown: (chart: C | null) => void;
  /** Applies the current look to whatever chart is there. */
  restyle: () => void;
}

/** Builds the chart while `ready()`, again whenever `restart` changes; `restyle` runs again whenever `style` changes. */
export function useChartBinding<E, C extends { remove(): void }>(
  host: RefObject<HTMLElement | null>,
  binding: ChartBinding<E, C>,
  restart: number,
  style: number,
): void {
  const latest = useRef(binding);
  latest.current = binding;
  useEffect(() => {
    const started = latest.current;
    if (!host.current || !started.ready()) return;
    const session: ChartSession<C> = { chart: null, closed: false };
    void started.load().then(() => {
      const engine = started.engine();
      if (session.closed || !started.admit() || !host.current || !engine) return;
      started.build(engine, host.current, session);
    });
    return () => {
      session.closed = true;
      started.teardown(session.chart);
      session.chart?.remove();
    };
  }, [host, restart]);
  useEffect(() => {
    latest.current.restyle();
  }, [style]);
}

export interface PriceLineSeries {
  createPriceLine(options: Record<string, unknown>): unknown;
  removePriceLine(line: unknown): void;
}

/**
 * Removes the lines in `held` from the series behind `series` and draws `draw()`'s lines, whenever `restart` changes.
 * With no series, nothing is removed or drawn.
 */
export function useSeriesPriceLines(
  series: RefObject<PriceLineSeries | null>,
  held: RefObject<unknown[]>,
  draw: () => Record<string, unknown>[],
  restart: number,
): void {
  const latest = useRef(draw);
  latest.current = draw;
  useEffect(() => {
    const target = series.current;
    if (!target) return;
    held.current.forEach((line) => target.removePriceLine(line));
    held.current = [];
    for (const options of latest.current()) held.current.push(target.createPriceLine(options));
  }, [series, held, restart]);
}
