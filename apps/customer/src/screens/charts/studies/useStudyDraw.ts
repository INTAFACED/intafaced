/**
 * Draws the study series on the workbench chart's host. Overlays go on pane 0 with the price; each study that has a
 * sub-pane (oscillators, volume, delta, MACD, Stochastic) gets its own pane, numbered from 1 in the order the studies
 * are listed.
 *
 * The series and panes are rebuilt only when the layout changes: the list of series, their panes, styles or colours, or
 * the tick. Otherwise the new values go into the series already drawn, so a poll never removes a pane (which would reset
 * a pane height the person dragged). Every series and pane this hook added is removed when the layout changes, the host
 * changes or the component unmounts, so nothing is left behind.
 */
import { useEffect, useRef } from 'react';
import type { ChartHost, ChartSeries } from '../chart-host';
import { priceFormat } from '../../trade/chart/chart-data';
import type { SeriesOut } from './compute';
import { NO_PANES, type PaneLayout } from './model';

/** The colour a token resolves to on this page (the `--if-*` custom properties). Empty when the token is not set. */
export function colorOf(token: string): string {
  if (typeof document === 'undefined') return '';
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(`--if-${token}`).trim();
  } catch {
    return '';
  }
}

/** The study group a series belongs to: the part of its key before the first colon (a study id has no colon). */
export const groupOf = (series: SeriesOut): string => series.key.split(':')[0]!;

/**
 * What one drawn layout holds: the host it is on, the layout's signature, its series in order, its indicator panes and
 * the study each one belongs to (index 0 is pane 1).
 */
interface Drawn {
  host: ChartHost;
  signature: string;
  apis: ChartSeries[];
  panes: number;
  paneGroups: string[];
}

/**
 * The layout a set of series draws into: every series' key, pane, style and colour, which studies sit on the main pane,
 * and the tick. Not the values, and not the pane sizes (those change without rebuilding, so no pane is reset).
 */
const signatureOf = (series: readonly SeriesOut[], tickSize: string, onMain: readonly string[]): string =>
  `${tickSize}#${series.map((s) => `${s.key}|${s.pane}|${s.style}|${s.color}`).join(';')}#${onMain.join(',')}`;

/** The main pane's share against an indicator pane of size 1, and the strip a collapsed or minimised pane keeps. */
const MAIN_FACTOR = 3;
const STRIP_FACTOR = 0.08;
const MAXIMISED_FACTOR = 12;

/** Each pane's stretch factor for a layout: the main pane first, then the indicator panes top to bottom. */
export function paneFactors(groups: readonly string[], layout: PaneLayout): number[] {
  const max = layout.maximised !== null && groups.includes(layout.maximised) ? layout.maximised : null;
  return [
    max ? STRIP_FACTOR : MAIN_FACTOR,
    ...groups.map((g) =>
      max ? (g === max ? MAXIMISED_FACTOR : STRIP_FACTOR) : layout.collapsed.includes(g) ? STRIP_FACTOR : (layout.sizes[g] ?? 1),
    ),
  ];
}

/** Applies a layout's sizes to the panes drawn, and writes what it applied on the host for the page and its journeys. */
function applyLayout(drawn: Drawn, layout: PaneLayout): void {
  const { host, paneGroups } = drawn;
  if (drawn.panes === 0) return;
  const factors = paneFactors(paneGroups, layout);
  host.chart.panes().forEach((p, n) => p.setStretchFactor(factors[n] ?? 1));
  host.element.dataset.studyPaneLayout = JSON.stringify(
    paneGroups.map((study, n) => ({
      pane: n + 1,
      study,
      collapsed: layout.collapsed.includes(study),
      maximised: layout.maximised === study,
      size: layout.sizes[study] ?? 1,
    })),
  );
}

/** The points a series draws: a gap is a point with no value; a histogram bar takes its tone's colour. */
function dataOf(s: SeriesOut): Array<{ time: number; value?: number; color?: string }> {
  return s.points.map((p) => {
    if (p.value === null) return { time: p.time };
    if (s.style === 'histogram') {
      const tone = p.tone === 'down' ? 'down' : 'up';
      return { time: p.time, value: p.value, color: colorOf(`vol-${tone}`) || colorOf(tone) || undefined };
    }
    return { time: p.time, value: p.value };
  });
}

function build(host: ChartHost, series: readonly SeriesOut[], tickSize: string, layout: PaneLayout): Drawn {
  const { lib, chart } = host;
  const apis: ChartSeries[] = [];
  const paneOf: number[] = [];
  const paneOfGroup = new Map<string, number>();
  const paneGroups: string[] = [];
  let panes = 0;
  for (const s of series) {
    let pane = 0;
    // A sub-pane study moved to the main pane draws over the price, on a scale of its own.
    const onMain = s.pane === 'sub' && layout.onMain.includes(groupOf(s));
    if (s.pane === 'sub' && !onMain) {
      const group = groupOf(s);
      const known = paneOfGroup.get(group);
      if (known !== undefined) pane = known;
      else {
        panes += 1;
        pane = panes;
        paneOfGroup.set(group, pane);
        paneGroups.push(group);
      }
    }
    const definition = s.style === 'histogram' ? lib.HistogramSeries : lib.LineSeries;
    const api = chart.addSeries(
      definition,
      {
        color: colorOf(s.color) || undefined,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        priceFormat: priceFormat(tickSize),
        ...(onMain ? { priceScaleId: `study-${groupOf(s)}` } : {}),
      },
      pane,
    );
    api.setData(dataOf(s));
    apis.push(api);
    paneOf.push(pane);
  }
  // What the library draws for each study series (its type, colour and pane), read back from the series itself, for the
  // page and its journeys: a check on these is a check on the drawing, not on the study's settings.
  host.element.dataset.studySeries = JSON.stringify(
    apis.map((api, n) => ({
      key: series[n]!.key,
      pane: paneOf[n],
      type: api.seriesType(),
      // A token that does not resolve was drawn in the library's default colour: recorded as '', not as that colour.
      color: colorOf(series[n]!.color) ? ((api.options() as { color?: string }).color ?? '') : '',
    })),
  );
  const drawn: Drawn = { host, signature: signatureOf(series, tickSize, layout.onMain), apis, panes, paneGroups };
  if (panes > 0) {
    // The number of indicator panes under the main pane, for the page and its journeys.
    host.element.dataset.studyPanes = String(panes);
    applyLayout(drawn, layout);
  }
  return drawn;
}

function teardown(drawn: Drawn): void {
  const { host, apis, panes } = drawn;
  const { chart } = host;
  delete host.element.dataset.studyPanes;
  delete host.element.dataset.studySeries;
  delete host.element.dataset.studyPaneLayout;
  for (const api of apis) {
    try {
      chart.removeSeries(api);
    } catch {
      /* The chart was replaced or is gone: nothing left to remove. */
    }
  }
  for (let p = panes; p >= 1; p -= 1) {
    try {
      chart.removePane(p);
    } catch {
      /* The pane is already gone. */
    }
  }
}

/**
 * Draws the series, laid out as `layout` says. `onResize` receives each indicator pane's size after the person drags a
 * pane border on the chart (against the main pane, so a size of 1 is the default share).
 */
export function useStudyDraw(
  host: ChartHost | null,
  series: readonly SeriesOut[],
  tickSize: string,
  layout: PaneLayout = NO_PANES,
  onResize?: (sizes: Record<string, number>) => void,
): void {
  const drawn = useRef<Drawn | null>(null);
  useEffect(() => {
    const current = drawn.current;
    if (!host || series.length === 0) {
      if (current) teardown(current);
      drawn.current = null;
      return;
    }
    if (current && current.host === host && current.signature === signatureOf(series, tickSize, layout.onMain)) {
      // The same layout: the values go into the series already drawn, and no pane is removed.
      series.forEach((s, n) => current.apis[n]?.setData(dataOf(s)));
      applyLayout(current, layout);
      return;
    }
    if (current) teardown(current);
    drawn.current = build(host, series, tickSize, layout);
  }, [host, series, tickSize, layout]);
  // Each pane's height in pixels as the library lays it out, read on demand by the page and its journeys.
  useEffect(() => {
    if (!host) return;
    const element = host.element as HTMLElement & { readPaneHeights?: () => number[] };
    element.readPaneHeights = () => host.chart.panes().map((p) => p.getHeight());
    return () => {
      delete element.readPaneHeights;
    };
  }, [host]);
  // A border the person dragged: the library changed the stretch factors itself; they are read back as sizes and kept.
  const resized = useRef(onResize);
  resized.current = onResize;
  useEffect(() => {
    if (!host) return;
    const read = () => {
      const current = drawn.current;
      // Only a plain layout is resized by dragging: a maximised or collapsed pane keeps its strip.
      if (!current || current.panes === 0 || !resized.current || layout.maximised !== null) return;
      const factors = host.chart.panes().map((p) => p.getStretchFactor());
      const main = factors[0];
      if (!main || current.paneGroups.length !== factors.length - 1) return;
      const sizes = Object.fromEntries(
        current.paneGroups.flatMap((g, n) => (layout.collapsed.includes(g) ? [] : [[g, (factors[n + 1]! / main) * MAIN_FACTOR]])),
      );
      const applied = paneFactors(current.paneGroups, layout);
      const moved = factors.some((f, n) => Math.abs(f / main - applied[n]! / applied[0]!) > 0.01);
      if (moved) resized.current(sizes);
    };
    host.element.addEventListener('pointerup', read);
    return () => host.element.removeEventListener('pointerup', read);
  }, [host, layout]);
  // Leaving the page removes what was drawn.
  useEffect(
    () => () => {
      if (drawn.current) teardown(drawn.current);
      drawn.current = null;
    },
    [],
  );
}
