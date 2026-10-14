import * as React from 'react';
import { cn } from './cn.js';

/** Thin a series to at most `max` points, always keeping the first and the last. */
export function thinSeries<T>(values: readonly T[], max = 48): T[] {
  if (values.length <= max) return [...values];
  const out: T[] = [];
  for (let i = 0; i < max; i += 1) {
    out.push(values[Math.round((i * (values.length - 1)) / (max - 1))] as T);
  }
  return out;
}

export interface SparklineGeometry {
  /** SVG `points` attribute for the polyline. */
  points: string;
  baselineY: number;
  lastX: number;
  lastY: number;
  direction: 'up' | 'down' | 'flat';
}

/**
 * Pure drawing math. Floats are allowed here and only here (UI-SPEC 1.1 rule 5):
 * these numbers are pixel coordinates, never money. Returns null when fewer
 * than two real points exist, so the caller draws nothing (never a made-up line).
 */
export function sparklineGeometry(
  values: readonly (string | number | null | undefined)[],
  width: number,
  height: number,
  pad = 3,
  maxPoints = 48,
): SparklineGeometry | null {
  const nums = values.map((v) => (v == null || v === '' ? Number.NaN : Number(v))).filter((n) => Number.isFinite(n));
  if (nums.length < 2) return null;
  const pts = thinSeries(nums, maxPoints);
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min;
  const innerW = width - 2 * pad;
  const innerH = height - 2 * pad;
  const y = (v: number) => (span === 0 ? height / 2 : pad + (1 - (v - min) / span) * innerH);
  const x = (i: number) => pad + (i / (pts.length - 1)) * innerW;
  const round = (n: number) => Math.round(n * 100) / 100;
  const coords = pts.map((v, i) => `${round(x(i))},${round(y(v))}`);
  const first = pts[0] as number;
  const last = pts[pts.length - 1] as number;
  return {
    points: coords.join(' '),
    baselineY: round(y(first)),
    lastX: round(x(pts.length - 1)),
    lastY: round(y(last)),
    direction: last > first ? 'up' : last < first ? 'down' : 'flat',
  };
}

export interface SparklineProps extends Omit<React.ComponentProps<'svg'>, 'values' | 'width' | 'height'> {
  /** Decimal strings (or numbers): closes, oldest first. At most 48 are drawn. */
  values: readonly (string | number | null | undefined)[];
  /** Pixel size. Market cards 154x56, watchlist 64x24, markets table 120x32. */
  width?: number;
  height?: number;
  /** Dot on the last point. */
  endDot?: boolean;
  /** Dotted baseline at the first value. */
  baseline?: boolean;
  /** Force the colour (the app passes the sign of the displayed %). Default: first vs last. */
  direction?: 'up' | 'down' | 'flat';
  /** Accessible description, e.g. "BTC, last 24 hours". Without it the chart is hidden from screen readers. */
  label?: string;
}

const stroke = { up: 'stroke-up-text', down: 'stroke-down-text', flat: 'stroke-fg-2' } as const;
const fill = { up: 'fill-up-text', down: 'fill-down-text', flat: 'fill-fg-2' } as const;

/**
 * Hand-built SVG polyline: stroke 1.5, colour by first vs last, dotted baseline
 * at the first value, optional end dot. No chart library.
 */
export function Sparkline({
  values,
  width = 154,
  height = 56,
  endDot = false,
  baseline = true,
  direction,
  label,
  className,
  ...props
}: SparklineProps) {
  const g = sparklineGeometry(values, width, height);
  const dir = direction ?? g?.direction ?? 'flat';
  return (
    <svg
      data-slot="sparkline"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn('block shrink-0 overflow-visible', className)}
      {...props}
    >
      {g ? (
        <>
          {baseline ? (
            <line x1={0} x2={width} y1={g.baselineY} y2={g.baselineY} strokeWidth={1} strokeDasharray="1 3" className="stroke-fg-3" />
          ) : null}
          <polyline points={g.points} fill="none" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className={stroke[dir]} />
          {endDot ? <circle cx={g.lastX} cy={g.lastY} r={3} className={fill[dir]} /> : null}
        </>
      ) : null}
    </svg>
  );
}
