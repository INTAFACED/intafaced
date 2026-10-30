import type { PoolCandle } from './pools-api';
import type { PoolsTranslate } from './copy';

const W = 600;
const H = 200;

/**
 * Candle geometry in SVG units. Numbers here only place shapes on the drawing; every figure a person reads comes from
 * the indexer's decimal strings, in the title of each candle and in the range line under the chart.
 */
export function candleGeometry(candles: readonly PoolCandle[], window: { start: number; seconds: number; width: number }) {
  if (candles.length === 0) return null;
  const highs = candles.map((c) => Number(c.high));
  const lows = candles.map((c) => Number(c.low));
  const top = Math.max(...highs);
  const bottom = Math.min(...lows);
  const span = top - bottom || Math.abs(top) || 1;
  const y = (price: string) => H - ((Number(price) - bottom) / span) * H;
  // Each candle sits at its own time across the day, so a quiet stretch shows as a gap and not as steady movement.
  const step = (W * window.width) / window.seconds;
  const body = Math.max(step * 0.6, 1);
  return candles.map((c) => {
    const x = ((c.start - window.start) / window.seconds) * W + step / 2;
    const open = y(c.open);
    const close = y(c.close);
    return {
      candle: c,
      x,
      wick: { y1: y(c.high), y2: y(c.low) },
      body: { x: x - body / 2, y: Math.min(open, close), width: body, height: Math.max(Math.abs(open - close), 1) },
      rising: Number(c.close) >= Number(c.open),
    };
  });
}

/** Lowest low and highest high as the indexer gave them, compared as decimals without a float. */
function extreme(values: readonly string[], pick: 'min' | 'max'): string {
  return values.reduce((best, value) => {
    const cmp = compareDecimal(value, best);
    return (pick === 'max' ? cmp > 0 : cmp < 0) ? value : best;
  });
}

/** Compares two non-negative decimal strings exactly. */
export function compareDecimal(a: string, b: string): number {
  const [ai = '0', af = ''] = a.split('.');
  const [bi = '0', bf = ''] = b.split('.');
  const width = Math.max(af.length, bf.length);
  const left = BigInt(ai + af.padEnd(width, '0'));
  const right = BigInt(bi + bf.padEnd(width, '0'));
  return left === right ? 0 : left > right ? 1 : -1;
}

export function PriceChart({
  candles,
  window,
  base,
  quote,
  width,
  when,
  t,
}: {
  candles: readonly PoolCandle[];
  /** The day the chart covers: its start in Unix seconds, its length, and one candle's width, both in seconds. */
  window: { start: number; seconds: number; width: number };
  base: string;
  quote: string;
  width: string;
  when: (date: Date) => string;
  t: PoolsTranslate;
}) {
  const geometry = candleGeometry(candles, window);
  const label = t('chartLabel', { base, quote, width });
  if (!geometry) return <p role="status">{t('chartEmpty')}</p>;
  return (
    <figure className="pool-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label} data-testid="pool-price-chart">
        {geometry.map((g) => (
          <g key={g.candle.start} data-testid="pool-candle" data-rising={g.rising}>
            <title>
              {t('candleTitle', {
                time: when(new Date(g.candle.start * 1000)),
                open: g.candle.open,
                high: g.candle.high,
                low: g.candle.low,
                close: g.candle.close,
                swaps: g.candle.swaps,
              })}
            </title>
            <line
              x1={g.x}
              x2={g.x}
              y1={g.wick.y1}
              y2={g.wick.y2}
              style={{ stroke: 'var(--if-text-muted)' }}
              vectorEffect="non-scaling-stroke"
            />
            <rect
              x={g.body.x}
              y={g.body.y}
              width={g.body.width}
              height={g.body.height}
              style={{ fill: g.rising ? 'var(--if-up-text)' : 'var(--if-down-text)' }}
            />
          </g>
        ))}
      </svg>
      <figcaption>
        {t('chartRange', {
          low: extreme(
            candles.map((c) => c.low),
            'min',
          ),
          high: extreme(
            candles.map((c) => c.high),
            'max',
          ),
          base,
          quote,
        })}
      </figcaption>
    </figure>
  );
}
