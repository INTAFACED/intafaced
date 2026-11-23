/**
 * Owner: lane B2 (templates). TimeLine: a line over time, where time sets the x position, so a missing stretch is a gap
 * of its real width and a point with no figure is left out, never drawn as zero. Values arrive as decimal strings; they
 * become floats here only to place pixels (the kit's rule: floats for drawing only).
 */
import * as React from 'react';
import type { DecimalString } from '../templates/types.js';
import type { DataMarks } from './b2-table.js';

/** One moment on the line. `value: null` is a moment with no figure: the line breaks there. */
export interface TimePoint {
  /** ISO time. */
  at: string;
  value: DecimalString | null;
}

/** The plot's own units: 1000 wide, so a room's test can read an x as a share of the width. */
const TW = 1000;
const TH = 240;

/** Drawing only: a decimal string as a float for a pixel position. */
const plot = (v: DecimalString): number => parseFloat(v);

/**
 * Where the line is drawn, in the plot's units (1000 by 240): each run of moments with a figure, the zero line when zero
 * is inside the range, and each moment's x. x is the moment's share of the time from first to last, rounded down, so
 * the first moment is at 0 and the last at 1000. Null when there is nothing to draw: no moments, no time between the
 * first and the last, or no moment with a figure.
 */
export function timeLinePlaces(points: readonly TimePoint[]) {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return null;
  const t0 = Date.parse(first.at);
  const span = Date.parse(last.at) - t0;
  if (!(span > 0)) return null;
  const known = points.flatMap((p) => (p.value === null ? [] : [plot(p.value)]));
  if (known.length === 0) return null;
  const top = Math.max(...known);
  const bottom = Math.min(...known);
  const range = top - bottom;
  const y = (v: number) => (range === 0 ? TH / 2 : TH - Math.floor(((v - bottom) * TH) / range));
  const xs = points.map((p) => Math.floor(((Date.parse(p.at) - t0) * TW) / span));
  const runs: { x: number; y: number }[][] = [];
  let run: { x: number; y: number }[] = [];
  points.forEach((p, i) => {
    if (p.value === null) {
      if (run.length > 0) runs.push(run);
      run = [];
      return;
    }
    run.push({ x: xs[i] ?? 0, y: y(plot(p.value)) });
  });
  if (run.length > 0) runs.push(run);
  return { runs, xs, zeroY: bottom <= 0 && top >= 0 ? y(0) : null, t0, span };
}

/** The moment nearest a share of the width (0 at the start, 1 at the end), by time. */
export function nearestPoint(points: readonly TimePoint[], share: number): number {
  const t0 = Date.parse(points[0]?.at ?? '');
  const at = t0 + share * (Date.parse(points[points.length - 1]?.at ?? '') - t0);
  let best = 0;
  let gap = Infinity;
  points.forEach((p, i) => {
    const off = Math.abs(Date.parse(p.at) - at);
    if (off < gap) [best, gap] = [i, off];
  });
  return best;
}

/** The moment a key moves the readout to: arrows step one, Home and End jump to the ends, Escape clears. */
export function stepPoint(key: string, current: number | null, count: number): number | null | undefined {
  const last = count - 1;
  if (key === 'Escape') return null;
  if (key === 'Home') return 0;
  if (key === 'End') return last;
  if (key === 'ArrowRight') return current === null ? last : Math.min(last, current + 1);
  if (key === 'ArrowLeft') return current === null ? last : Math.max(0, current - 1);
  return undefined;
}

/**
 * A line over time (the profit and loss line, the value line). Time sets the x position, so a missing stretch is a gap
 * of its real width; a moment with no figure breaks the line, never drops it to zero. A dashed zero line shows when zero
 * is inside the range. Pointing at the plot, or focusing it and using the arrow keys (Home, End; Escape clears), names
 * one moment in the readout (`readout` says it in the room's words; `data-at` carries its time). `keys` names the plot
 * for the keyboard ("Use the arrow keys to read each point"). Nothing to draw shows `empty` in place of a made-up line.
 * `caption` (the range's ends, the low and high) goes under the chart. `marks` are the drawing's own (`data-chart`),
 * set on the svg with each run's `data-run`, so a room's test reads the same geometry. The room keeps a table of every
 * point next to it: that is the chart's text equivalent.
 */
export function TimeLine({
  label,
  points,
  readout,
  keys,
  empty,
  caption,
  tone = 'neutral',
  marks,
}: {
  label: string;
  points: readonly TimePoint[];
  readout: (point: TimePoint) => React.ReactNode;
  keys: string;
  empty: React.ReactNode;
  caption?: React.ReactNode;
  tone?: 'up' | 'down' | 'neutral';
  marks?: DataMarks;
}) {
  const chart = React.useMemo(() => timeLinePlaces(points), [points]);
  const [at, setAt] = React.useState<number | null>(null);
  const focus = at === null ? null : (points[at] ?? null);
  if (!chart)
    return (
      <figure className="lt-chart lt-timeline" aria-label={label} data-empty="true">
        <p className="lt-timeline-empty" role="status">
          {empty}
        </p>
      </figure>
    );
  const pick = (event: React.PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width > 0) setAt(nearestPoint(points, (event.clientX - box.left) / box.width));
  };
  const key = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const next = stepPoint(event.key, at, points.length);
    if (next === undefined) return;
    event.preventDefault();
    setAt(next);
  };
  return (
    <figure className="lt-chart lt-timeline" data-tone={tone}>
      <div className="lt-timeline-plot" role="group" aria-label={keys} tabIndex={0} onKeyDown={key} onBlur={() => setAt(null)}>
        <svg
          viewBox={`0 0 ${TW} ${TH}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={label}
          {...marks}
          onPointerMove={pick}
          onPointerLeave={() => setAt(null)}
        >
          {chart.zeroY !== null ? (
            <line className="lt-timeline-zero" x1="0" x2={TW} y1={chart.zeroY} y2={chart.zeroY} vectorEffect="non-scaling-stroke" />
          ) : null}
          {chart.runs.map((run, index) =>
            run.length === 1 && run[0] ? (
              <line
                key={index}
                className="lt-chart-line lt-timeline-dot"
                x1={run[0].x}
                x2={run[0].x}
                y1={run[0].y}
                y2={run[0].y}
                vectorEffect="non-scaling-stroke"
                data-run={index}
              />
            ) : (
              <polyline
                key={index}
                className="lt-chart-line"
                points={run.map((p) => `${p.x},${p.y}`).join(' ')}
                vectorEffect="non-scaling-stroke"
                data-run={index}
              />
            ),
          )}
          {at !== null ? (
            <line className="lt-timeline-cursor" x1={chart.xs[at]} x2={chart.xs[at]} y1="0" y2={TH} vectorEffect="non-scaling-stroke" />
          ) : null}
        </svg>
        <p className="lt-timeline-readout" role="status" data-at={focus?.at}>
          {focus ? readout(focus) : null}
        </p>
      </div>
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}
