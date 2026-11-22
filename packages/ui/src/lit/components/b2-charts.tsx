/**
 * Owner: lane B2 (templates). LineChart, AreaChart, Sparkline, Bars and Parts: plain SVG, every chart with its data as a
 * table (its text equivalent, and Pro's "table behind the chart"). Values arrive as decimal strings; they become
 * floats here only to place pixels (the kit's rule: floats for drawing only). Parts never draws a whole its
 * parts don't add up to: it adds "Other" for the difference or refuses.
 */
import * as React from 'react';
import { formatMoney, reconcileParts, type Part } from '../templates/money.js';
import type { DecimalString } from '../templates/types.js';

export interface Point {
  /** ISO date or time. */
  at: string;
  value: DecimalString;
}

/** Drawing only: a decimal string as a float for a pixel position. */
const plot = (v: DecimalString): number => parseFloat(v);

const W = 600;
const H = 200;
const PAD = 8;

function scale(points: readonly Point[]) {
  const ys = points.map((p) => plot(p.value));
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const span = max - min || 1;
  const x = (i: number) => PAD + (i * (W - 2 * PAD)) / Math.max(1, points.length - 1);
  const y = (v: number) => H - PAD - ((v - min) * (H - 2 * PAD)) / span;
  return { x, y, ys };
}

function DataTable({ caption, rows, asset }: { caption: string; rows: readonly { label: string; value: DecimalString }[]; asset: string }) {
  return (
    <table className="lt-sr">
      <caption>{caption}</caption>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label}>
            <th scope="row">{r.label}</th>
            <td>{formatMoney({ value: r.value, asset })}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface SeriesProps {
  label: string;
  points: readonly Point[];
  asset: string;
  /** `up` or `down` colours the line by direction; `neutral` uses the light. */
  tone?: 'up' | 'down' | 'neutral';
  /** Data is live (not stale): a live dot marks the last point. */
  live?: boolean;
}

function Series({
  label,
  points,
  asset,
  tone = 'neutral',
  live = false,
  fill,
  soft = false,
}: SeriesProps & { fill: boolean; soft?: boolean }) {
  const gradient = `lt-chart-soft-${React.useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  if (points.length < 2) return null;
  const { x, y, ys } = scale(points);
  const d = ys.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${d} L${x(points.length - 1).toFixed(1)},${H - PAD} L${x(0).toFixed(1)},${H - PAD} Z`;
  const last = points.length - 1;
  return (
    <figure className="lt-chart" data-tone={tone}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
        {fill && soft ? (
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" className="lt-chart-soft-top" />
              <stop offset="1" className="lt-chart-soft-bottom" />
            </linearGradient>
          </defs>
        ) : null}
        {fill ? (
          <path className="lt-chart-area" data-soft={soft || undefined} d={area} style={soft ? { fill: `url(#${gradient})` } : undefined} />
        ) : null}
        <path className="lt-chart-line" d={d} vectorEffect="non-scaling-stroke" />
        {live ? <circle className="lt-chart-live" data-live="" cx={x(last)} cy={y(ys[last]!)} r={4} /> : null}
      </svg>
      <DataTable caption={label} asset={asset} rows={points.map((p) => ({ label: p.at, value: p.value }))} />
    </figure>
  );
}

export function LineChart(props: SeriesProps) {
  return <Series {...props} fill={false} />;
}

/** `soft` fades the fill from the line down to nothing (the balance over time); without it the fill is flat, as before. */
export function AreaChart({ soft, ...props }: SeriesProps & { soft?: boolean }) {
  return <Series {...props} fill soft={soft} />;
}

/**
 * A small trend line with no axes, for a card or a row: the line only, coloured by its last value against its first,
 * or by `tone` when the room already shows a direction (the sign of its change figure), so the two never disagree.
 * Fewer than two points draw nothing (never a made-up line); the caller says why. `label` names it for a screen reader.
 */
export function Sparkline({
  label,
  values,
  tone,
  size = 'card',
}: {
  label: string;
  values: readonly DecimalString[];
  tone?: 'up' | 'down' | 'neutral';
  size?: 'card' | 'row';
}) {
  if (values.length < 2) return null;
  const { x, y, ys } = scale(values.map((value, i) => ({ at: String(i), value })));
  const d = ys.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const first = ys[0] ?? 0;
  const last = ys.at(-1) ?? first;
  return (
    <figure className="lt-chart lt-spark" data-size={size} data-tone={tone ?? (last > first ? 'up' : last < first ? 'down' : 'neutral')}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
        <path className="lt-chart-line" d={d} vectorEffect="non-scaling-stroke" />
      </svg>
    </figure>
  );
}

/**
 * Which stretches of a time window hold data: one track, each covered range drawn where it falls and the gaps left
 * empty, so a gap reads as a gap. `from` and `to` are the window (ISO times); a range too short to see keeps a sliver.
 * Times become floats here only to place pixels. `rangeTestId` marks each range for a room's journey test.
 */
export function Coverage({
  label,
  from,
  to,
  ranges,
  rangeTestId,
}: {
  label: string;
  from: string;
  to: string;
  ranges: readonly { from: string; to: string }[];
  rangeTestId?: string;
}) {
  const start = Date.parse(from);
  const span = Math.max(1, Date.parse(to) - start);
  const at = (iso: string) => Math.min(100, Math.max(0, ((Date.parse(iso) - start) / span) * 100));
  return (
    <div className="lt-coverage" role="img" aria-label={label}>
      {ranges.map((range) => (
        <span
          key={range.from}
          data-testid={rangeTestId}
          style={{ insetInlineStart: `${at(range.from)}%`, inlineSize: `${Math.max(0.5, at(range.to) - at(range.from))}%` }}
        />
      ))}
    </div>
  );
}

export function Bars({ label, bars, asset }: { label: string; bars: readonly { label: string; value: DecimalString }[]; asset: string }) {
  // Negative bars hang below a zero baseline, so a loss never draws as nothing.
  const ys = bars.map((b) => plot(b.value));
  const max = Math.max(0, ...ys);
  const min = Math.min(0, ...ys);
  const span = max - min || 1;
  const y = (v: number) => H - PAD - ((v - min) * (H - 2 * PAD)) / span;
  const w = (W - 2 * PAD) / Math.max(1, bars.length);
  return (
    <figure className="lt-chart lt-bars">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
        {ys.map((v, i) => {
          const top = Math.min(y(v), y(0));
          const h = Math.abs(y(v) - y(0));
          return (
            <rect
              key={bars[i]!.label}
              className="lt-bar"
              data-negative={v < 0 || undefined}
              x={PAD + i * w + w * 0.15}
              y={top}
              width={w * 0.7}
              height={h}
              rx={4}
            />
          );
        })}
      </svg>
      <DataTable caption={label} asset={asset} rows={bars} />
    </figure>
  );
}

/**
 * Parts of a whole. The list is always drawn (it is the 3D sphere's text equivalent too); the bar above it is the
 * flat picture. If the parts can't be reconciled to the total, the chart refuses in words instead of drawing.
 */
export function Parts({
  label,
  total,
  parts,
  asset,
  otherLabel = 'Other',
  refusedLabel = 'These parts don’t add up to the total shown, so they aren’t drawn.',
}: {
  label: string;
  total: DecimalString;
  parts: readonly Part[];
  asset: string;
  otherLabel?: string;
  refusedLabel?: string;
}) {
  const r = reconcileParts(total, parts, otherLabel);
  if (!r.ok) {
    return (
      <p className="lt-chart-refused" data-reason={r.reason}>
        {refusedLabel}
      </p>
    );
  }
  const t = plot(total) || 1;
  return (
    <figure className="lt-parts" aria-label={label}>
      <div className="lt-parts-bar" aria-hidden="true">
        {r.parts.map((p, i) => (
          <span key={p.label} data-part={i} style={{ flexGrow: plot(p.value) / t }} />
        ))}
      </div>
      <ul className="lt-parts-list">
        {r.parts.map((p, i) => (
          <li key={p.label}>
            <span className="lt-parts-swatch" data-part={i} aria-hidden="true" />
            <span>{p.label}</span>
            <span className="lt-parts-value" dir="ltr" data-ltr="">
              {formatMoney({ value: p.value, asset })}
            </span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
