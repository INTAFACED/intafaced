// TODO(B1): remove double. Stand-in for packages/ui Sparkline (UI-SPEC §4.1): hand-built SVG polyline,
// <=48 points, stroke 1.5, colour by first-vs-last, dotted baseline at the first value, end dot.
// Floats are allowed here: this file only draws.
import type { Decimal } from '../../../data/types';

export interface SparklineProps {
  points: Decimal[] | undefined;
  width: number;
  height: number;
  /** Accessible name; the drawing is otherwise decorative. */
  label?: string;
}

export function Sparkline({ points, width, height, label }: SparklineProps) {
  const pad = 4;
  const values = (points ?? []).map((point) => Number(point)).filter((value) => Number.isFinite(value));
  const size = { width, height, viewBox: `0 0 ${width} ${height}`, className: 'if-spark' };
  const aria = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true };
  if (values.length < 2) {
    // No history yet: draw only the dotted baseline, never an invented line.
    return (
      <svg {...size} {...aria}>
        <line className="if-spark__base" x1={0} x2={width} y1={height / 2} y2={height / 2} />
      </svg>
    );
  }
  const step = Math.max(1, Math.ceil(values.length / 48));
  const sampled = values.filter((_, index) => index % step === 0 || index === values.length - 1);
  const min = Math.min(...sampled);
  const max = Math.max(...sampled);
  const span = max - min || 1;
  const x = (index: number) => pad + (index / (sampled.length - 1)) * (width - pad * 2);
  const y = (value: number) => height - pad - ((value - min) / span) * (height - pad * 2);
  const path = sampled.map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(' ');
  const first = sampled[0]!;
  const last = sampled[sampled.length - 1]!;
  const tone = last > first ? 'up' : last < first ? 'down' : 'flat';
  return (
    <svg {...size} {...aria} data-tone={tone}>
      <line className="if-spark__base" x1={0} x2={width} y1={y(first)} y2={y(first)} />
      <polyline className="if-spark__line" points={path} fill="none" />
      <circle className="if-spark__dot" cx={x(sampled.length - 1)} cy={y(last)} r={3} />
    </svg>
  );
}
