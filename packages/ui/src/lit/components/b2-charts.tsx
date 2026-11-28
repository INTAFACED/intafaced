/**
 * Owner: lane B2 (templates). LineChart, AreaChart, Sparkline, Candles, Bars and Parts: plain SVG, every chart with its data as a
 * table (its text equivalent, and Pro's "table behind the chart"). Values arrive as decimal strings; they become
 * floats here only to place pixels (the kit's rule: floats for drawing only). Parts never draws a whole its
 * parts don't add up to: it adds "Other" for the difference or refuses.
 */
import * as React from 'react';
import { formatMoney, reconcileParts, type Part } from '../templates/money.js';
import type { DecimalString } from '../templates/types.js';
import type { DataMarks } from './b2-table.js';
import { useHideBalances } from '../../components/numbers.js';
import { HIDDEN_MASK } from './b2-values.js';

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
    // Hidden in a box rather than on the table itself: a table ignores the hidden box's 1px height, so its rows would
    // still stretch the page by their full height.
    <div className="lt-sr">
      <table>
        {/* Hidden on its own too: inside the hidden box its text would still have a box of its own, cut by that box. */}
        <caption className="lt-sr">{caption}</caption>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <th scope="row">{r.label}</th>
              <td>{formatMoney({ value: r.value, asset })}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface SeriesProps {
  label: string;
  points: readonly Point[];
  asset: string;
  /** `up` or `down` colours the line by direction; `neutral` uses the light; `ink` the text colour (a balance's hero line). */
  tone?: 'up' | 'down' | 'neutral' | 'ink';
  /** Data is live (not stale): a live dot marks the last point. */
  live?: boolean;
  /** Faint horizontal guide lines behind the line (a hero chart). */
  grid?: boolean;
  /** Fill the container's height instead of the kit's fixed one (a chart inside a tile). */
  fit?: boolean;
  /** The last point's value, formatted ("$24,860.40"): drawn in a pill over a dot, with a dashed line down from it. */
  marker?: string;
}

function Series({
  label,
  points,
  asset,
  tone = 'neutral',
  live = false,
  fill,
  soft = false,
  grid = false,
  fit = false,
  marker,
}: SeriesProps & { fill: boolean; soft?: boolean }) {
  const gradient = `lt-chart-soft-${React.useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  if (points.length < 2) return null;
  const { x, y, ys } = scale(points);
  const d = ys.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${d} L${x(points.length - 1).toFixed(1)},${H - PAD} L${x(0).toFixed(1)},${H - PAD} Z`;
  const last = points.length - 1;
  const end = { x: x(last), y: y(ys[last] ?? 0) };
  // Where the marker sits, as a share of the drawing (the chart is drawn left to right in every language).
  const at = { inlineStart: `${((end.x / W) * 100).toFixed(2)}%`, blockStart: `${((end.y / H) * 100).toFixed(2)}%` };
  return (
    <figure className="lt-chart" data-tone={tone} data-marked={marker === undefined ? undefined : ''} data-fit={fit || undefined} dir="ltr">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
        {grid
          ? [0.25, 0.5, 0.75].map((f) => (
              <line key={f} className="lt-chart-grid" x1={0} x2={W} y1={H * f} y2={H * f} vectorEffect="non-scaling-stroke" />
            ))
          : null}
        {marker !== undefined ? (
          <line className="lt-chart-drop" x1={end.x} x2={end.x} y1={end.y} y2={H - PAD} vectorEffect="non-scaling-stroke" />
        ) : null}
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
        {live ? <circle className="lt-chart-live" data-live="" cx={end.x} cy={end.y} r={4} /> : null}
      </svg>
      {marker !== undefined ? (
        <span className="lt-chart-marker" style={{ insetInlineStart: at.inlineStart, insetBlockStart: at.blockStart }} aria-hidden="true">
          <span className="lt-chart-marker-dot" />
          <span className="lt-chart-marker-pill">{marker}</span>
        </span>
      ) : null}
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
  fit = false,
}: {
  label: string;
  values: readonly DecimalString[];
  tone?: 'up' | 'down' | 'neutral';
  size?: 'card' | 'row';
  /** Fill the container's height instead of the kit's fixed one. */
  fit?: boolean;
}) {
  if (values.length < 2) return null;
  const { x, y, ys } = scale(values.map((value, i) => ({ at: String(i), value })));
  const d = ys.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const first = ys[0] ?? 0;
  const last = ys.at(-1) ?? first;
  return (
    <figure
      className="lt-chart lt-spark"
      data-size={size}
      data-fit={fit || undefined}
      data-tone={tone ?? (last > first ? 'up' : last < first ? 'down' : 'neutral')}
    >
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
        <path className="lt-chart-line" d={d} vectorEffect="non-scaling-stroke" />
      </svg>
    </figure>
  );
}

/** One candle: its four prices as decimal strings, never a number. */
export interface Candle {
  /** Unique in the chart (the candle's start time); React's key. */
  key: string;
  open: DecimalString;
  high: DecimalString;
  low: DecimalString;
  close: DecimalString;
  /** The candle's start in Unix seconds: with the chart's `window`, it places the candle on the time axis. */
  at?: number;
  /** The candle's own words (its time and figures): its tooltip, and its line in the chart's text equivalent. */
  title?: string;
  /** The candle's own marks (`data-testid`, `data-time`), what a room's tests find it by. */
  marks?: DataMarks;
}

/** A time axis: its start in Unix seconds, its length and one candle's width, both in seconds. */
export interface CandleWindow {
  start: number;
  seconds: number;
  width: number;
}

/** Where each candle is drawn, in the chart's own units. Prices become floats here only to place pixels. */
export function candlePlaces(candles: readonly Candle[], window?: CandleWindow) {
  if (candles.length === 0) return [];
  const top = Math.max(...candles.map((c) => plot(c.high)));
  const bottom = Math.min(...candles.map((c) => plot(c.low)));
  const span = top - bottom || Math.abs(top) || 1;
  const y = (v: DecimalString) => H - PAD - ((plot(v) - bottom) * (H - 2 * PAD)) / span;
  // On a time axis each candle sits at its own time, so a quiet stretch stays a gap; without one they sit side by side.
  const step = window ? (W * window.width) / window.seconds : W / candles.length;
  const body = Math.max(step * 0.6, 1);
  return candles.map((candle, i) => {
    const x = (window && candle.at !== undefined ? ((candle.at - window.start) / window.seconds) * W : i * step) + step / 2;
    const open = y(candle.open);
    const close = y(candle.close);
    return {
      candle,
      x,
      wick: { y1: y(candle.high), y2: y(candle.low) },
      body: { x: x - body / 2, y: Math.min(open, close), width: body, height: Math.max(Math.abs(open - close), 1) },
      rising: plot(candle.close) >= plot(candle.open),
    };
  });
}

/**
 * A candle chart: one candle per period, its wick from low to high and its body from open to close, in the rise
 * colour when it closed at or above its open and the fall colour when below (`data-rising` says which, in words for
 * tests; colour is never the only carrier: each candle's `title` holds its figures). With `window` the candles sit at
 * their own times, so a gap is a gap. No candles draw `empty` in place of a made-up chart, and the figure keeps its
 * name. `caption` (a range line, a count) goes under the chart. `marks` are the figure's own (`data-pool`).
 */
export function Candles({
  label,
  candles,
  window,
  empty,
  caption,
  marks,
}: {
  label: string;
  candles: readonly Candle[];
  window?: CandleWindow;
  empty: React.ReactNode;
  caption?: React.ReactNode;
  marks?: DataMarks;
}) {
  const places = candlePlaces(candles, window);
  const titled = candles.filter((c) => c.title);
  return (
    <figure className="lt-chart lt-candles" aria-label={label} data-empty={places.length === 0 || undefined} {...marks}>
      {places.length === 0 ? (
        <p className="lt-candles-empty" role="status">
          {empty}
        </p>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
          {places.map((p) => (
            <g key={p.candle.key} className="lt-candle" data-rising={p.rising} {...p.candle.marks}>
              {p.candle.title ? <title>{p.candle.title}</title> : null}
              <line x1={p.x} x2={p.x} y1={p.wick.y1} y2={p.wick.y2} vectorEffect="non-scaling-stroke" />
              <rect x={p.body.x} y={p.body.y} width={p.body.width} height={p.body.height} />
            </g>
          ))}
        </svg>
      )}
      {titled.length > 0 ? (
        <ul className="lt-sr">
          {titled.map((c) => (
            <li key={c.key}>{c.title}</li>
          ))}
        </ul>
      ) : null}
      {caption ? <figcaption>{caption}</figcaption> : null}
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
      {/* Each bar's name and amount under it, so the picture reads without a legend; the table below says the same to
          assistive tech. */}
      <div
        className="lt-bars-key"
        aria-hidden="true"
        style={{ gridTemplateColumns: `repeat(${Math.max(1, bars.length)}, minmax(0, 1fr))` }}
      >
        {bars.map((b) => (
          <span key={b.label} data-bar={b.label}>
            <span className="lt-bars-name">{b.label}</span>
            <span className="lt-bars-value">{formatMoney({ value: b.value, asset })}</span>
          </span>
        ))}
      </div>
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
  hidden,
  legend = 'list',
}: {
  label: string;
  total: DecimalString;
  parts: readonly Part[];
  asset: string;
  otherLabel?: string;
  refusedLabel?: string;
  /** Masks the amounts (the bar stays); without it, the person's hide-balances switch decides. */
  hidden?: boolean;
  /** `row`: the legend on one wrapping line under the bar (a hero panel); `list` (default): one row per part. */
  legend?: 'list' | 'row';
}) {
  const hideFromSwitch = useHideBalances();
  const masked = hidden ?? hideFromSwitch;
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
    <figure className="lt-parts" aria-label={label} data-legend={legend}>
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
            <span className="lt-parts-value" dir="ltr" data-ltr="" data-hidden={masked || undefined}>
              {masked ? HIDDEN_MASK : formatMoney({ value: p.value, asset })}
            </span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

export interface Share {
  key: string;
  label: string;
  /** The part's share of the whole as a ratio string ("0.5433"), never a number. */
  share: DecimalString;
  /** The share in words as the room writes it ("54.33%", "<0.01%"). */
  text: string;
}

/**
 * Shares of a whole the room already worked out (an allocation by coin, kind or place): the same bar and list as Parts,
 * with each share's own words instead of an amount. Up to six shares take their own colour; the room groups the rest.
 */
export function Shares({ label, shares }: { label: string; shares: readonly Share[] }) {
  return (
    <figure className="lt-parts" aria-label={label}>
      <div className="lt-parts-bar" aria-hidden="true">
        {shares.map((s, i) => (
          <span key={s.key} data-part={i} style={{ flexGrow: plot(s.share) }} />
        ))}
      </div>
      <ul className="lt-parts-list">
        {shares.map((s, i) => (
          <li key={s.key} data-group={s.key}>
            <span className="lt-parts-swatch" data-part={i} aria-hidden="true" />
            <span>{s.label}</span>
            <span className="lt-parts-value" dir="ltr" data-ltr="">
              {s.text}
            </span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
