import type { PayoffRow } from './model';
import { chartGeometry } from './model';

const W = 1000;
const H = 300;

/**
 * A plain SVG line of the result at expiry. Coordinates are whole numbers made in model.ts with bigint division, so no
 * money value is turned into a float to draw it. Colours are --if tokens only. The table beside it carries the same
 * numbers for anyone who cannot see the line.
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
    <figure className="m-0 flex flex-col gap-1">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label} className="h-48 w-full rounded-sm bg-panel">
        {geometry.zeroY !== null ? (
          <line
            x1="0"
            x2={W}
            y1={geometry.zeroY}
            y2={geometry.zeroY}
            stroke="var(--if-line-stronger)"
            strokeDasharray="6 6"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        <polyline
          points={geometry.line}
          fill="none"
          stroke="var(--if-lime)"
          strokeWidth="2"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <figcaption className="flex justify-between text-xs text-fg-2">
        <span>{lowLabel}</span>
        <span>{highLabel}</span>
      </figcaption>
    </figure>
  );
}
