import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionProvider } from '../features/session/session';
import { resetFavoritesCache, useFavorites } from './favorites';
import { useCandles, useMarkets, useMovers, usePortfolio, useSparklines, useTicker, useTickers } from './hooks';
import { createPoller, setDefaultPoller } from './poll';
import type { Loadable } from './types';

/** Server rendering reads each hook's first snapshot without starting any polling (no subscribe, no request). */
function firstRender() {
  const seen: Record<string, Loadable<unknown>> = {};
  function Probe() {
    seen.markets = useMarkets();
    seen.tickers = useTickers();
    seen.ticker = useTicker('BTC/USDT');
    seen.candles = useCandles('BTC/USDT', '1h', 24);
    seen.sparklines = useSparklines(['BTC/USDT']);
    seen.noSparklines = useSparklines([]);
    seen.movers = useMovers(6);
    seen.portfolio = usePortfolio();
    seen.favorites = { status: 'ready', data: useFavorites(null).favorites, asOf: 0 };
    return null;
  }
  renderToString(
    <SessionProvider>
      <Probe />
    </SessionProvider>,
  );
  return seen;
}

afterEach(() => {
  setDefaultPoller(null);
  resetFavoritesCache();
});

describe('hooks wiring', () => {
  it('every hook returns a Loadable on first render and starts no request', () => {
    const poller = createPoller();
    setDefaultPoller(poller);
    const seen = firstRender();
    for (const key of ['markets', 'tickers', 'ticker', 'candles', 'sparklines', 'movers'])
      expect(seen[key], key).toEqual({ status: 'loading' });
    expect(seen.noSparklines).toEqual({ status: 'empty' });
    expect(seen.favorites).toMatchObject({ data: [] });
    expect(poller.stats().totalRequests).toBe(0);
  });

  it('signed out, the portfolio is a typed refusal rather than a request', () => {
    setDefaultPoller(createPoller());
    expect(firstRender().portfolio).toEqual({ status: 'refused', code: 'auth.required' });
  });
});
