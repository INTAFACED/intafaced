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

/** What one drawn layout holds: the host it is on, the layout's signature, its series in order, and its indicator panes. */
interface Drawn {
  host: ChartHost;
  signature: string;
  apis: ChartSeries[];
  panes: number;
}

/** The layout a set of series draws into: every series' key, pane, style and colour, and the tick. Not the values. */
const signatureOf = (series: readonly SeriesOut[], tickSize: string): string =>
  `${tickSize}#${series.map((s) => `${s.key}|${s.pane}|${s.style}|${s.color}`).join(';')}`;

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

function build(host: ChartHost, series: readonly SeriesOut[], tickSize: string): Drawn {
  const { lib, chart } = host;
  const apis: ChartSeries[] = [];
  const paneOf: number[] = [];
  const paneOfGroup = new Map<string, number>();
  let panes = 0;
  for (const s of series) {
    let pane = 0;
    if (s.pane === 'sub') {
      const group = groupOf(s);
      const known = paneOfGroup.get(group);
      if (known !== undefined) pane = known;
      else {
        panes += 1;
        pane = panes;
        paneOfGroup.set(group, pane);
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
      color: (api.options() as { color?: string }).color ?? '',
    })),
  );
  if (panes > 0) {
    const all = chart.panes();
    all.forEach((p, n) => p.setStretchFactor(n === 0 ? 3 : 1));
    // The number of indicator panes under the main pane, for the page and its journeys.
    host.element.dataset.studyPanes = String(panes);
  }
  return { host, signature: signatureOf(series, tickSize), apis, panes };
}

function teardown(drawn: Drawn): void {
  const { host, apis, panes } = drawn;
  const { chart } = host;
  delete host.element.dataset.studyPanes;
  delete host.element.dataset.studySeries;
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

export function useStudyDraw(host: ChartHost | null, series: readonly SeriesOut[], tickSize: string): void {
  const drawn = useRef<Drawn | null>(null);
  useEffect(() => {
    const current = drawn.current;
    if (!host || series.length === 0) {
      if (current) teardown(current);
      drawn.current = null;
      return;
    }
    if (current && current.host === host && current.signature === signatureOf(series, tickSize)) {
      // The same layout: the values go into the series already drawn, and no pane is removed.
      series.forEach((s, n) => current.apis[n]?.setData(dataOf(s)));
      return;
    }
    if (current) teardown(current);
    drawn.current = build(host, series, tickSize);
  }, [host, series, tickSize]);
  // Leaving the page removes what was drawn.
  useEffect(
    () => () => {
      if (drawn.current) teardown(drawn.current);
      drawn.current = null;
    },
    [],
  );
}
