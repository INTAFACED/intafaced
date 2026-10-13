import { useEffect, useState } from 'react';
import { useChartCandles, type Candle, type Loadable } from './deps';
import { ALL_FALLBACK, type RangeSpec } from './ranges';

/**
 * Candles for the selected range. "All" asks for weekly candles; a market younger than two weeks has fewer than two of
 * them, which cannot be drawn as a line, so for that market "All" reads daily candles instead (and keeps doing so).
 * The caller always gets the interval and limit actually in use, so labels and the fitted view follow.
 */
export function useRangeCandles(
  symbol: string,
  range: RangeSpec,
): { candles: Loadable<Candle[]>; interval: RangeSpec['interval']; limit: number } {
  const [dailyFor, setDailyFor] = useState<string | null>(null);
  const fallback = range.id === 'All' && dailyFor === symbol;
  const spec = fallback ? ALL_FALLBACK : range;
  const loaded = useChartCandles(symbol, spec.interval, spec.limit);
  const thin = range.id === 'All' && !fallback && loaded.status === 'ready' && loaded.data.length < 2;
  useEffect(() => {
    if (thin) setDailyFor(symbol);
  }, [thin, symbol]);
  return { candles: thin ? { status: 'loading' } : loaded, interval: spec.interval, limit: spec.limit };
}
