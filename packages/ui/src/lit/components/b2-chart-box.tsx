/**
 * Owner: lane B2 (templates). ChartBox and ChartCanvas: a box of definite size for a charting library that draws into
 * an element it is given (a canvas engine needs a width and a height before it can draw), so a room never sizes one
 * with its own CSS or an inline style.
 */
import type * as React from 'react';
import type { DataMarks } from './b2-table.js';

/**
 * The chart's box: full width, a fixed height from the kit (22.5rem, the coin page's), at every width. Whatever it
 * holds fills it: the drawn chart (`ChartCanvas`), or the room's loading, empty or error state in its place, so the
 * page does not jump when the chart arrives. `marks` are the box's own (`data-testid`).
 */
export function ChartBox({ marks, children }: { marks?: DataMarks; children: React.ReactNode }) {
  return (
    <div className="lt-chart-box" {...marks}>
      {children}
    </div>
  );
}

/**
 * The drawn chart inside a `ChartBox`: a figure named by `label`, and inside it the element the library draws into
 * (`host`, the ref the room hands the library), which fills the box exactly. A figure, not an image: the library may
 * draw controls a person can reach (a crosshair, a scale to drag), and an image's content can hold none. `marks` are the picture's, `hostMarks`
 * the drawing element's, so a room's tests find both as before.
 */
export function ChartCanvas({
  label,
  host,
  marks,
  hostMarks,
}: {
  label: string;
  host: React.Ref<HTMLDivElement>;
  marks?: DataMarks;
  hostMarks?: DataMarks;
}) {
  return (
    <div className="lt-chart-canvas" role="figure" aria-label={label} {...marks}>
      <div ref={host} className="lt-chart-canvas-host" {...hostMarks} />
    </div>
  );
}
