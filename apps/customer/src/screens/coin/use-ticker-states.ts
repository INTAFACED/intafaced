import { useMemo, useSyncExternalStore } from 'react';
import { tickerSource, useDataEnv, type Loadable, type TickerRow } from './deps';

type States = Readonly<Record<string, Loadable<TickerRow>>>;
const NONE: States = {};

/**
 * The ticker of each symbol, side by side, so the page can tell which of a coin's markets can be priced. It reads the same
 * shared sources as `useTicker`, so it adds no requests. A missing, loading or failed one is just its own entry; none
 * hides another.
 */
export function useTickerStates(symbols: readonly string[]): States {
  const env = useDataEnv();
  const key = symbols.join(',');
  const source = useMemo(() => {
    const parts = key ? key.split(',').map((symbol) => [symbol, tickerSource(env, symbol)] as const) : [];
    let last: readonly Loadable<TickerRow>[] | null = null;
    let result: States = NONE;
    return {
      subscribe(listener: () => void) {
        const stops = parts.map(([, part]) => part.subscribe(listener));
        return () => stops.forEach((stop) => stop());
      },
      getSnapshot(): States {
        const snaps = parts.map(([, part]) => part.getSnapshot());
        if (last && snaps.every((snap, i) => snap === last![i])) return result;
        last = snaps;
        result = parts.length ? Object.fromEntries(parts.map(([symbol], i) => [symbol, snaps[i]!])) : NONE;
        return result;
      },
    };
  }, [env, key]);
  return useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
}
