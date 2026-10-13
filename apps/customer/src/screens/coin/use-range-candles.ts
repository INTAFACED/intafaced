import { useEffect, useState } from 'react';
import { useChartCandles, type Candle, type Loadable } from './deps';
import { candleLadder, type RangeSpec } from './ranges';

/**
 * Candles for the selected range. When a market is younger than the range, the range's own candles are too few to
 * draw (under two), so the next finer ones are read instead (`candleLadder`) and the choice is kept for that market and
 * range. The caller gets the interval and limit actually in use, so the fitted view follows.
 */
export function useRangeCandles(
  symbol: string,
  range: RangeSpec,
): { candles: Loadable<Candle[]>; interval: RangeSpec['interval']; limit: number } {
  const ladder = candleLadder(range.id);
  const key = `${symbol}:${range.id}`;
  const [step, setStep] = useState<{ key: string; index: number }>({ key, index: 0 });
  const index = step.key === key ? Math.min(step.index, ladder.length - 1) : 0;
  const spec = ladder[index]!;
  const loaded = useChartCandles(symbol, spec.interval, spec.limit);
  const thin = loaded.status === 'ready' && loaded.data.length < 2 && index < ladder.length - 1;
  useEffect(() => {
    if (thin) setStep({ key, index: index + 1 });
  }, [thin, key, index]);
  return { candles: thin ? { status: 'loading' } : loaded, interval: spec.interval, limit: spec.limit };
}
