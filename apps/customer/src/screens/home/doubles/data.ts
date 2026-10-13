// TODO(B1/B3): remove double. Stand-ins for the hooks in apps/customer/src/data (UI-SPEC §4.2).
// Each hook asks `/__mock/<name>` once; the Playwright test answers those requests, so loading,
// empty, refused and error states are driven from the network exactly as the real hooks would see them.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Decimal, Loadable, MarketRow, Movers, PortfolioSummary, TickerRow } from '../../../data/types';
import { useSession } from '../../../features/session/session';

type Wire<T> = { kind: 'ready'; data: T } | { kind: 'empty' } | { kind: 'refused'; code: string };

function useMock<T>(name: string): Loadable<T> {
  const [state, setState] = useState<Loadable<T>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    setState({ status: 'loading' });
    setAttempt((value) => value + 1);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/__mock/${name}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const wire = (await response.json()) as Wire<T>;
        if (wire.kind === 'ready') setState({ status: 'ready', data: wire.data, asOf: Date.now() });
        else if (wire.kind === 'empty') setState({ status: 'empty' });
        else setState({ status: 'refused', code: wire.code });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setState({ status: 'error', retry });
      });
    return () => controller.abort();
  }, [name, attempt, retry]);
  return state;
}

export const usePortfolio = (): Loadable<PortfolioSummary> => useMock<PortfolioSummary>('portfolio');
export const useMarkets = (): Loadable<MarketRow[]> => useMock<MarketRow[]>('markets');
export const useTickers = (): Loadable<Record<string, TickerRow>> => useMock<Record<string, TickerRow>>('tickers');
export const useMovers = (limit: number): Loadable<Movers> => {
  void limit;
  return useMock<Movers>('movers');
};
export function useSparklines(symbols: string[]): Loadable<Record<string, Decimal[]>> {
  const all = useMock<Record<string, Decimal[]>>('sparklines');
  const key = symbols.join('|');
  return useMemo(() => {
    if (all.status !== 'ready') return all;
    const wanted = new Set(key.split('|'));
    return { ...all, data: Object.fromEntries(Object.entries(all.data).filter(([symbol]) => wanted.has(symbol))) };
  }, [all, key]);
}

/** Same device-store key the old Trade screen uses, so existing favourites survive. */
export function useFavorites(): string[] {
  const { userId } = useSession();
  return useMemo(() => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(`trade-favorites:${userId ?? 'guest'}`) ?? '[]');
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }, [userId]);
}

export function primarySymbolFor(asset: string, markets: MarketRow[]): string | null {
  return (
    markets.find((market) => market.base === asset && market.quote === 'USDT')?.symbol ??
    markets.find((market) => market.base === asset && market.quote === 'USDC')?.symbol ??
    null
  );
}
