/**
 * Draws the study series on the workbench chart's host. Overlays go on pane 0 with the price; each study that has a
 * sub-pane (oscillators, volume, delta, MACD, Stochastic) gets its own pane, numbered from 1 in the order the studies
 * are listed. A change redraws from scratch: every series and pane this hook added is removed first, so nothing is left
 * behind and no pane index drifts. The hook returns the cleanup the effect needs; it touches nothing else on the chart.
 */
import { useEffect } from 'react';
import type { ChartHost } from '../chart-host';
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

export function useStudyDraw(host: ChartHost | null, series: readonly SeriesOut[], tickSize: string): void {
  useEffect(() => {
    if (!host || series.length === 0) return;
    const { lib, chart } = host;
    const added: unknown[] = [];
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
      api.setData(
        s.points.map((p) => {
          if (p.value === null) return { time: p.time };
          if (s.style === 'histogram') {
            const tone = p.tone === 'down' ? 'down' : 'up';
            return { time: p.time, value: p.value, color: colorOf(`vol-${tone}`) || colorOf(tone) || undefined };
          }
          return { time: p.time, value: p.value };
        }),
      );
      added.push(api);
    }
    if (panes > 0) {
      const all = chart.panes();
      all.forEach((p, n) => p.setStretchFactor(n === 0 ? 3 : 1));
    }
    return () => {
      for (const api of added) {
        try {
          chart.removeSeries(api as Parameters<typeof chart.removeSeries>[0]);
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
    };
  }, [host, series, tickSize]);
}
