/**
 * Marks and one stepped line drawn on a Lightweight Charts chart (J-charts-desk-20: a journal trade's entry, stop and
 * exit over its bar replay). The chart is the library's own object, typed here by the few calls this hook makes, so it
 * knows no screen (garden/no-effect-in-product). Everything it drew is removed when the marks change and when it goes.
 */
import { useEffect, useRef } from 'react';

/** A series the hook added: it sets its data, and removes it after. */
export interface LineHandle {
  setData(data: unknown[]): void;
}

export interface MarksHost {
  lib: {
    LineSeries: unknown;
    createSeriesMarkers(series: unknown, markers: unknown[]): { setMarkers(markers: unknown[]): void };
  };
  chart: {
    addSeries(definition: unknown, options?: Record<string, unknown>): LineHandle;
    removeSeries(series: LineHandle): void;
  };
  main: unknown;
}

export interface SeriesMark {
  /** Epoch seconds of the bar it is drawn on. */
  time: number;
  position: 'aboveBar' | 'belowBar';
  shape: 'arrowUp' | 'arrowDown' | 'circle';
  /** A role token (`--lit-up`), read from the page when drawn. */
  token: string;
  text: string;
}

export interface SteppedLine {
  /** A role token, read from the page when drawn. */
  token: string;
  points: readonly { time: number; value: number }[];
}

/** Draws `marks` on the main series and `line` as a stepped line, again only when `key` changes. */
export function useSeriesMarks(host: MarksHost | null, marks: readonly SeriesMark[], line: SteppedLine | null, key: string): void {
  const latest = useRef({ marks, line });
  latest.current = { marks, line };
  useEffect(() => {
    if (!host) return;
    const css = getComputedStyle(document.documentElement);
    const colour = (token: string) => css.getPropertyValue(token).trim();
    const now = latest.current;
    const drawn = host.lib.createSeriesMarkers(
      host.main,
      now.marks.map((m) => ({ time: m.time, position: m.position, shape: m.shape, color: colour(m.token), text: m.text })),
    );
    let series: LineHandle | null = null;
    if (now.line && now.line.points.length > 0) {
      series = host.chart.addSeries(host.lib.LineSeries, {
        color: colour(now.line.token),
        lineWidth: 2,
        lineStyle: 2,
        // The library's stepped line: the value holds until the next point.
        lineType: 1,
        priceLineVisible: false,
        lastValueVisible: true,
        crosshairMarkerVisible: false,
      });
      series.setData(now.line.points.map((p) => ({ time: p.time, value: p.value })));
    }
    return () => {
      drawn.setMarkers([]);
      if (series) host.chart.removeSeries(series);
    };
  }, [host, key]);
}
