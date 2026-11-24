import { Candles, type Candle } from '@intafaced/ui/lit/templates';
import type { PoolCandle } from './pools-api';
import type { PoolsTranslate } from './copy';

/**
 * The pool's candles as the kit draws them: each at its own start time, with its figures in its title. Prices stay the
 * indexer's decimal strings; the kit turns them into floats only to place pixels.
 */
export function poolCandles(candles: readonly PoolCandle[], when: (date: Date) => string, t: PoolsTranslate): Candle[] {
  return candles.map((c) => ({
    key: String(c.start),
    at: c.start,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    title: t('candleTitle', {
      time: when(new Date(c.start * 1000)),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      swaps: c.swaps,
    }),
    marks: { 'data-testid': 'pool-candle' },
  }));
}

/**
 * The chart's time axis for a day of candles: the indexer's day starts at any second (now less 24 hours), but its candles
 * start on whole widths, so the newest candle runs past the day's end and the oldest may start before it. The axis is
 * widened to whole candle widths on both sides, so every candle the day holds is drawn inside the chart.
 */
export function candleAxis(since: number, seconds: number, width: number): { start: number; seconds: number; width: number } {
  const start = Math.floor(since / width) * width;
  const end = Math.ceil((since + seconds) / width) * width;
  return { start, seconds: Math.max(end - start, width), width };
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
  return (
    <Candles
      label={t('chartLabel', { base, quote, width })}
      candles={poolCandles(candles, when, t)}
      window={window}
      empty={t('chartEmpty')}
      caption={
        candles.length === 0
          ? undefined
          : t('chartRange', {
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
            })
      }
    />
  );
}
