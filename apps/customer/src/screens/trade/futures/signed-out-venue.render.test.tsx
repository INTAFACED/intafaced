// @vitest-environment happy-dom
// Signed out on a deployment whose venue door is on, /trade/futures lists the venue's perpetuals, not our own `/markets`
// (spot only on the beta). The answers below are the beta's (TEST figures).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const world = vi.hoisted(() => ({
  userId: null as string | null,
  states: { status: 'loading' } as unknown,
  askedCandles: [] as string[],
}));

const perp = (symbol: string) => ({
  symbol,
  kind: 'perpetual' as const,
  baseAsset: symbol.split('-')[0]!,
  quoteAsset: 'USDC',
  tickSize: '0.1',
  lotSize: '0.001',
  status: 'trading',
  session: { known: false },
  listing: { opensAt: '2026-11-01T00:00:00.000Z', delistsAt: null, routing: 'show', open: true, delisted: false },
});
const spot = (symbol: string) => ({ ...perp(symbol), kind: 'spot' as const, quoteAsset: 'USDC' });
const BETA_STATES = {
  status: 'ready',
  asOf: 0,
  data: {
    venueId: 'test-venue',
    asOf: '2026-11-24T00:00:00.000Z',
    value: {
      venue: { id: 'test-venue', displayName: 'TEST Venue' },
      markets: [spot('BTC-USDC'), perp('BTC-PERP'), perp('ETH-PERP')],
      test: true,
      label: 'TEST',
    },
  },
};

vi.mock('../../../features/trade/use-venue-mode', () => ({ useVenueMode: () => ({ mode: 'off' }) }));
vi.mock('../../../features/session/session', () => ({ useSession: () => ({ userId: world.userId, api: {} }) }));
vi.mock('../../../data/venue-market-states', async (original) => ({
  ...(await original<typeof import('../../../data/venue-market-states')>()),
  useVenueMarketStates: () => world.states,
}));
// Our own `/markets` on the beta lists only spot markets (`swap: false` on all 16): the futures list is empty.
vi.mock('./data', async (original) => {
  const real = await original<typeof import('./data')>();
  const loading = () => ({ status: 'loading' });
  const mocked: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(real)) mocked[name] = typeof value === 'function' && name.startsWith('use') ? loading : value;
  return {
    ...mocked,
    useFuturesMarkets: () => ({ status: 'ready', data: [], asOf: 0 }),
    useFuturesRefresh: () => () => undefined,
    useRefreshRiskStops: () => () => undefined,
    useVenuePublicBook: (symbol: string | null) =>
      symbol
        ? {
            status: 'ready',
            asOf: 0,
            data: {
              venueId: 'test-venue',
              asOf: '2026-11-24T00:00:00.000Z',
              test: true,
              value: { symbol, bids: [{ price: '60000', amount: '0.5' }], asks: [{ price: '60010', amount: '0.4' }] },
            },
          }
        : { status: 'empty' },
  };
});
vi.mock('../desk/data', () => ({ useBalances: () => ({ status: 'loading' }) }));
vi.mock('../desk/hooks', () => ({ useNow: () => 0 }));
vi.mock('../chart/candles', async (original) => ({
  ...(await original<typeof import('../chart/candles')>()),
  useChartCandles: (symbol: string, interval: string) => {
    world.askedCandles.push(`${symbol}:${interval}`);
    return { status: 'ready', data: [{ t: 0, o: '1', h: '2', l: '1', c: '2', v: '1', filled: false }], asOf: 0 };
  },
}));
vi.mock('../chart/PriceChart', () => ({ PriceChart: () => <div data-testid="price-chart" /> }));

import FuturesScreen from './index';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  world.userId = null;
  world.states = BETA_STATES;
  world.askedCandles = [];
});

afterEach(() => {
  if (root) {
    const mounted = root;
    root = null;
    act(() => mounted.unmount());
  }
  host.remove();
});

function render(search = '') {
  root = createRoot(host);
  const mounted = root;
  act(() => mounted.render(<FuturesScreen path="/trade/futures" search={search} params={{}} />));
}

/** The contract picker's choices, as a person sees them on opening it. */
function contractOptions(): string[] {
  const picker = host.querySelector<HTMLButtonElement>('[data-testid="venue-public-contracts"] [role="combobox"]');
  if (!picker) return [];
  act(() => picker.click());
  return [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent ?? '');
}

describe('/trade/futures signed out, the venue door on', () => {
  it('lists the perpetuals the venue lists, with their chart and book, never our empty own list', () => {
    render();
    expect(host.textContent).not.toContain('No futures contract is listed');
    expect(contractOptions()).toEqual(['BTC-PERP', 'ETH-PERP']);
    expect(host.querySelector('[data-testid="venue-public-chart"]')?.getAttribute('data-market')).toBe('BTC-PERP');
    expect(world.askedCandles[0]).toBe('BTC-PERP:15m');
    const book = host.querySelector('[data-testid="venue-public-book"]');
    expect(book?.getAttribute('data-market')).toBe('BTC-PERP');
    expect([...book!.querySelectorAll('[data-testid="venue-public-book-row"]')].map((r) => r.getAttribute('data-side'))).toEqual([
      'ask',
      'bid',
    ]);
    expect(host.querySelector('[data-testid="venue-test"]')?.textContent).toBe('TEST');
    expect(host.textContent).toContain('Sign in to open a position on BTC-PERP.');
  });

  it('opens the contract the link names', () => {
    render('?symbol=ETH-PERP');
    expect(host.querySelector('[data-testid="venue-public-book"]')?.getAttribute('data-market')).toBe('ETH-PERP');
  });

  it('keeps today’s desk where the door is off here', () => {
    world.states = { status: 'refused', code: 'trade.user_venue_off' };
    render();
    expect(host.querySelector('[data-testid="venue-public-contracts"]')).toBeNull();
    expect(host.querySelector('[data-testid="futures-empty-desk"]')).not.toBeNull();
  });

  it('keeps today’s desk for a signed-in person whose venue mode is off', () => {
    world.userId = 'u1';
    render();
    expect(host.querySelector('[data-testid="venue-public-contracts"]')).toBeNull();
    expect(host.querySelector('[data-testid="futures-empty-desk"]')).not.toBeNull();
  });
});
