import { addDecimal, compareDecimal, formatAmount, isDecimalString, permille } from '@/lib/merchants/money';

export interface BarPoint {
  /** `YYYY-MM-DD` */
  readonly day: string;
  /** Decimal string, or null when that day could not be read (shown as a gap, never as zero). */
  readonly value: string | null;
}

const W = 640;
const H = 168;
const PAD = { top: 12, right: 8, bottom: 26, left: 8 };

/**
 * One daily bar series for one asset. Heights come from exact bigint ratios;
 * the numbers on screen are the original strings. A day that failed to load is
 * a hatched gap, so "no data" never looks like "zero". A table sits beside the
 * picture for anyone who cannot read the picture (spec B6).
 */
export function BarChart({
  title,
  assetCode,
  points,
  tone,
}: {
  title: string;
  assetCode: string;
  points: readonly BarPoint[];
  tone: 'volume' | 'revenue';
}) {
  const valid = points.filter((p): p is { day: string; value: string } => p.value !== null && isDecimalString(p.value));
  const max = valid.reduce((m, p) => (compareDecimal(p.value, m) === 1 ? p.value : m), '0');
  const total = valid.reduce((sum, p) => addDecimal(sum, p.value), '0');
  const gaps = points.length - valid.length;
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const slot = innerW / Math.max(points.length, 1);
  const barW = Math.max(4, slot * 0.58);
  const descId = `chart-${tone}-${assetCode}`;
  const allZero = valid.length > 0 && compareDecimal(max, '0') === 0;

  return (
    <figure className="mp-chart" data-tone={tone}>
      <figcaption>
        <strong>{title}</strong>
        <span className="mp-muted">
          {' '}
          · {assetCode} · {points.length} days · total <span className="mp-num">{formatAmount(total)}</span>
          {gaps > 0 ? ` · ${gaps} day${gaps === 1 ? '' : 's'} could not be read` : ''}
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={descId}>
        <title id={descId}>{`${title} per day in ${assetCode}. Highest day ${formatAmount(max)}.`}</title>
        <line className="mp-chart__base" x1={PAD.left} x2={W - PAD.right} y1={PAD.top + innerH} y2={PAD.top + innerH} />
        <line className="mp-chart__grid" x1={PAD.left} x2={W - PAD.right} y1={PAD.top} y2={PAD.top} />
        {points.map((p, i) => {
          const x = PAD.left + slot * i + (slot - barW) / 2;
          if (p.value === null || !isDecimalString(p.value)) {
            return (
              <g key={p.day}>
                <rect className="mp-chart__gap" x={x} y={PAD.top + innerH - 14} width={barW} height={14} />
                <title>{`${p.day}: could not be read`}</title>
              </g>
            );
          }
          const h = (permille(p.value, max) / 1000) * innerH;
          const height = compareDecimal(p.value, '0') === 1 ? Math.max(2, h) : 0;
          return (
            <g key={p.day}>
              <rect
                className="mp-chart__bar"
                data-latest={i === points.length - 1 ? 'true' : undefined}
                x={x}
                y={PAD.top + innerH - height}
                width={barW}
                height={height}
                rx={2}
              />
              <title>{`${p.day}: ${formatAmount(p.value)} ${assetCode}`}</title>
            </g>
          );
        })}
        {points.map((p, i) =>
          points.length <= 14 || i % Math.ceil(points.length / 10) === 0 ? (
            <text key={p.day} className="mp-chart__tick" x={PAD.left + slot * i + slot / 2} y={H - 8} textAnchor="middle">
              {p.day.slice(5)}
            </text>
          ) : null,
        )}
      </svg>
      {allZero ? <p className="mp-muted mp-chart__note">Every day in this range is zero.</p> : null}
      <details className="mp-chart__table">
        <summary>Show as a table</summary>
        <table className="mp-table">
          <caption className="mp-visually-hidden">{`${title} per day in ${assetCode}`}</caption>
          <thead>
            <tr>
              <th scope="col">Day (UTC)</th>
              <th scope="col" className="mp-right">
                {assetCode}
              </th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.day}>
                <th scope="row">{p.day}</th>
                <td className="mp-right mp-num">{p.value === null ? 'could not be read' : formatAmount(p.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
