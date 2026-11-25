// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { SessionProvider } from '../../../features/session/session';
import { createPoller, setDefaultPoller } from '../../../data/poll';
import TradeMarketsScreen from './index';

// Renders Markets (/trade), signed out, against the three beta responses:
// - GET /api/v1/markets?limit=500: 16 spot markets, each active: true, status: null
// - GET /api/v1/tickers?limit=500: prices for BTC/USDC (last 65213.84), BTC/USDT, ETH/USDC, ETH/USDT, IFC/USDT
// - GET /api/v1/venue/market-states: BTC-PERP, ETH-PERP, BTC-USDC, each listing.open: true, status: null
// Illustrative TEST prices matching the wire shapes.

const BETA_SPOT_PAIRS = [
  ['BTC', 'USDC', '0.01'],
  ['BTC', 'USDT', '0.01'],
  ['ETH', 'USDC', '0.01'],
  ['ETH', 'USDT', '0.01'],
  ['IFC', 'USDT', '0.0001'],
  ['SOL', 'USDT', '0.01'],
  ['XRP', 'USDT', '0.0001'],
  ['DOGE', 'USDT', '0.00001'],
  ['ADA', 'USDT', '0.0001'],
  ['AVAX', 'USDT', '0.01'],
  ['DOT', 'USDT', '0.01'],
  ['LINK', 'USDT', '0.01'],
  ['LTC', 'USDT', '0.01'],
  ['MATIC', 'USDT', '0.0001'],
  ['UNI', 'USDT', '0.01'],
  ['ATOM', 'USDT', '0.01'],
] as const;

function wireMarket(base: string, quote: string, tickSize: string) {
  return {
    id: `${base}/${quote}`,
    symbol: `${base}/${quote}`,
    base,
    quote,
    settle: null,
    baseId: base,
    quoteId: quote,
    type: 'spot',
    spot: true,
    swap: false,
    future: false,
    option: false,
    contract: false,
    linear: null,
    inverse: null,
    active: true,
    orderable: true,
    paper: false,
    status: null,
    lifecycle: null,
    schedule: 'crypto-24x7',
    sessionOpen: true,
    nextSessionChange: null,
    hours: { kind: 'continuous' },
    taker: '0.001',
    maker: '0.001',
    contractSize: null,
    expiry: null,
    expiryDatetime: null,
    strike: null,
    optionType: null,
    precisionMode: 'TICK_SIZE',
    precision: { amount: '0.0001', price: tickSize },
    limits: {
      amount: { min: null, max: null },
      price: { min: null, max: null },
      cost: { min: null, max: null },
      leverage: { min: null, max: null },
    },
  };
}

function wireTicker(symbol: string, last: string, open: string, quoteVolume: string) {
  const now = Date.now();
  return {
    symbol,
    timestamp: now,
    datetime: new Date(now).toISOString(),
    high: last,
    low: open,
    bid: null,
    bidVolume: null,
    ask: null,
    askVolume: null,
    vwap: null,
    open,
    close: last,
    last,
    previousClose: null,
    change: null,
    percentage: null,
    average: null,
    baseVolume: '10',
    quoteVolume,
  };
}

const BETA_MARKETS = BETA_SPOT_PAIRS.map(([base, quote, tick]) => wireMarket(base, quote, tick));

const BETA_TICKERS = {
  'BTC/USDC': wireTicker('BTC/USDC', '65213.84', '64000.00', '1250000.00'),
  'BTC/USDT': wireTicker('BTC/USDT', '65210.00', '64100.00', '9800000.00'),
  'ETH/USDC': wireTicker('ETH/USDC', '3210.50', '3150.00', '420000.00'),
  'ETH/USDT': wireTicker('ETH/USDT', '3211.00', '3160.00', '4100000.00'),
  'IFC/USDT': wireTicker('IFC/USDT', '0.4120', '0.4000', '150000.00'),
};

function betaVenueMarketStates(btcSpotStatus: 'trading' | 'halted' | 'cancel_only' | null = null) {
  const opensAt = '2026-11-20T00:00:00.000Z';
  const listing = { opensAt, delistsAt: null, routing: 'show' as const, open: true, delisted: false };
  return {
    venueId: 'hyperliquid-testnet',
    asOf: new Date().toISOString(),
    value: {
      venue: { id: 'hyperliquid-testnet', displayName: 'TEST venue (testnet)' },
      markets: [
        {
          symbol: 'BTC-PERP',
          kind: 'perpetual',
          baseAsset: 'BTC',
          quoteAsset: 'USDC',
          tickSize: '0.1',
          lotSize: '0.001',
          status: null,
          session: { known: false },
          listing,
        },
        {
          symbol: 'ETH-PERP',
          kind: 'perpetual',
          baseAsset: 'ETH',
          quoteAsset: 'USDC',
          tickSize: '0.01',
          lotSize: '0.01',
          status: null,
          session: { known: false },
          listing,
        },
        {
          symbol: 'BTC-USDC',
          kind: 'spot',
          baseAsset: 'BTC',
          quoteAsset: 'USDC',
          tickSize: '0.01',
          lotSize: '0.0001',
          status: btcSpotStatus,
          session: { known: false },
          listing,
        },
      ],
      test: true,
    },
  };
}

let host: HTMLDivElement;
let root: Root;

function stubBetaFetch(btcSpotStatus: 'trading' | 'halted' | 'cancel_only' | null = null) {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const pathname = new URL(raw, 'http://localhost').pathname;
    if (pathname === '/api/v1/markets') {
      return new Response(JSON.stringify(BETA_MARKETS), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (pathname === '/api/v1/tickers') {
      return new Response(JSON.stringify(BETA_TICKERS), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (pathname === '/api/v1/venue/market-states') {
      return new Response(JSON.stringify(betaVenueMarketStates(btcSpotStatus)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (pathname.startsWith('/api/v1/ohlcv/')) {
      return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (pathname.includes('/api/identity/trpc/auth.refresh')) {
      return new Response(JSON.stringify({ error: { message: 'signed out' } }), { status: 401 });
    }
    return new Response(JSON.stringify({ error: { message: `unexpected ${pathname}` } }), { status: 404 });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
}

async function mountScreen() {
  await act(async () => {
    root.render(
      <SessionProvider>
        <TradeMarketsScreen path="/trade" search="" params={{}} />
      </SessionProvider>,
    );
  });
  await flush();
}

const rowByPair = (pair: string) =>
  Array.from(host.querySelectorAll<HTMLElement>('[data-testid="mkt-row"]')).find(
    (row) => row.querySelector('[data-testid="mkt-name__ticker"]')?.textContent?.trim() === pair,
  );

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  setDefaultPoller(createPoller());
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  setDefaultPoller(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Markets (/trade) on the beta responses (#10835)', () => {
  it('lists all 16 spot markets with their prices when venue market-states reports status: null', async () => {
    stubBetaFetch(null);
    await mountScreen();

    const text = host.textContent ?? '';
    expect(text).not.toContain('No markets are open right now.');
    expect(text).not.toContain('Prices have not arrived');
    expect(text).not.toContain('Include paused');

    const drawnPairs = Array.from(host.querySelectorAll('[data-testid="mkt-row"] [data-testid="mkt-name__ticker"]')).map((n) =>
      n.textContent?.trim(),
    );
    expect(drawnPairs).toHaveLength(16);
    expect(new Set(drawnPairs)).toEqual(new Set(BETA_SPOT_PAIRS.map(([base, quote]) => `${base}/${quote}`)));

    // BTC/USDC (matched across BTC-USDC in venue/market-states and BTC/USDC in /tickers) shows its price and is open.
    const btcUsdc = rowByPair('BTC/USDC');
    expect(btcUsdc, 'BTC/USDC row').toBeTruthy();
    expect(btcUsdc?.querySelector('[data-slot="price"]')?.textContent?.trim()).toBe('$65,213.84');
    const btcAction = btcUsdc?.querySelector('[data-col="action"] a[role="button"]');
    expect(btcAction, 'BTC/USDC has an enabled action link, not a paused button').toBeTruthy();
    expect(btcAction?.getAttribute('href')).toBeTruthy();

    // The other four priced spot markets show their prices, and unpriced markets show a dash.
    expect(rowByPair('BTC/USDT')?.querySelector('[data-slot="price"]')?.textContent?.trim()).toBe('$65,210.00');
    expect(rowByPair('ETH/USDC')?.querySelector('[data-slot="price"]')?.textContent?.trim()).toBe('$3,210.50');
    expect(rowByPair('ETH/USDT')?.querySelector('[data-slot="price"]')?.textContent?.trim()).toBe('$3,211.00');
    expect(rowByPair('IFC/USDT')?.querySelector('[data-slot="price"]')?.textContent?.trim()).toBe('$0.4120');
    expect(rowByPair('SOL/USDT')?.querySelector('[data-slot="price"]')?.textContent?.trim()).toBe('—');
  });

  it('in Pro layout, draws BTC/USDC with unknown venue status as open, not Paused', async () => {
    localStorage.setItem('intafaced.customer.view.v1', JSON.stringify({ layoutMode: 'pro' }));
    stubBetaFetch(null);
    await mountScreen();

    const btcUsdc = rowByPair('BTC/USDC');
    expect(btcUsdc, 'BTC/USDC row').toBeTruthy();
    const statusCell = btcUsdc?.querySelector('[data-col="status"]')?.textContent?.trim();
    expect(statusCell).not.toBe('Paused');
    expect(statusCell).toBe('Open');
  });

  it('keeps an explicitly halted venue market paused while still showing the other 15 open spot markets', async () => {
    stubBetaFetch('halted');
    await mountScreen();

    const drawnPairs = Array.from(host.querySelectorAll('[data-testid="mkt-row"] [data-testid="mkt-name__ticker"]')).map((n) =>
      n.textContent?.trim(),
    );
    expect(drawnPairs).toHaveLength(15);
    expect(drawnPairs).not.toContain('BTC/USDC');
    expect(drawnPairs).toContain('BTC/USDT');
    expect(host.textContent).toContain('Include paused');
  });
});
