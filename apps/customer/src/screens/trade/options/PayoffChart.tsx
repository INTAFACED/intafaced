import type { PayoffRow } from './model';
import { chartGeometry } from './model';

const W = 1000;
const H = 300;

/**
 * A plain SVG line of the result at expiry, drawn with the kit's chart parts. Coordinates are whole numbers made in
 * model.ts with bigint division, so no money value is turned into a float to draw it, and each point sits at its own
 * price (a strike is never moved to an even step). The table beside it carries the same numbers for anyone who cannot
 * see the line.
 */
export function PayoffChart({
  rows,
  label,
  lowLabel,
  highLabel,
}: {
  rows: readonly PayoffRow[];
  label: string;
  lowLabel: string;
  highLabel: string;
}) {
  const geometry = chartGeometry(rows, W, H);
  if (!geometry) return null;
  return (
    <figure className="lt-chart" data-tone="neutral">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
        {geometry.zeroY !== null ? (
          <line className="lt-chart-zero" x1="0" x2={W} y1={geometry.zeroY} y2={geometry.zeroY} vectorEffect="non-scaling-stroke" />
        ) : null}
        <polyline className="lt-chart-line" points={geometry.line} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption className="lt-chart-axis">
        <span>{lowLabel}</span>
        <span>{highLabel}</span>
      </figcaption>
    </figure>
  );
}
