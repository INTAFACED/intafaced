import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { VenueMode } from '../../features/trade/use-venue-mode';
import type { VenueOrder } from '../../features/trade/venue-api';

const state: { mode: VenueMode; owner: string | null; openOrders: VenueOrder[]; history: VenueOrder[] } = {
  mode: { mode: 'off' },
  owner: null,
  openOrders: [],
  history: [],
};

vi.mock('../../features/trade/use-venue-mode', () => ({
  useVenueMode: () => state.mode,
}));

vi.mock('../../features/trade/venue/VenueKit', async (original) => {
  const real = await original<typeof import('../../features/trade/venue/VenueKit')>();
  return {
    ...real,
    VenueFrame: ({ children }: { children: React.ReactNode }) => <div data-mock="venue-frame">{children}</div>,
    WalletBar: () => <div data-mock="wallet-bar" />,
    useOwner: () => state.owner,
    useVenueAccount: () => ({
      balances: { data: null, failure: null, loading: false },
      openOrders: { data: { venueId: 'test', asOf: '2026-11-24T12:00:00.000Z', value: state.openOrders }, failure: null, loading: false },
      fills: { data: null, failure: null, loading: false },
      positions: { data: null, failure: null, loading: false },
      reload: () => undefined,
    }),
    useVenueActions: () => ({
      run: async () => ({ kind: 'rejected' as const }),
      resend: async () => ({ kind: 'rejected' as const }),
      keptSignature: () => undefined,
    }),
    useVenueApi: () => ({}),
  };
});

vi.mock('../../shared/resource', () => ({
  useResource: () => ({
    resource: {
      status: 'ready' as const,
      data: state.history.map((order) => ({ order, placedAt: '2026-11-24T12:00:00.000Z' })),
    },
    reload: () => undefined,
  }),
}));

vi.mock('../../features/session/session', () => ({
  useSession: () => ({ userId: 'u-1' }),
}));

vi.mock('../trade/desk/data', () => ({
  useOpenOrders: () => ({ status: 'ready' as const, data: [] }),
  useClosedOrders: () => ({ status: 'ready' as const, data: [] }),
  useDeskMarkets: () => ({ status: 'ready' as const, data: [] }),
  useFills: () => ({ status: 'ready' as const, data: [] }),
  useRefreshPrivate: () => () => undefined,
}));

import { OrdersPanel } from './TradeTabs';

const SAMPLE_OPEN: VenueOrder = {
  venueOrderId: '1',
  venueClientOrderId: '0x11111111111111111111111111111111',
  symbol: 'BTC-USDC',
  side: 'buy',
  type: 'limit',
  timeInForce: 'GTC',
  price: '50000',
  amount: '0.01',
  filled: '0',
  remaining: '0.01',
  averagePrice: null,
  status: 'open',
  locked: '500',
  lockedAsset: 'USDC',
  reduceOnly: false,
};

const SAMPLE_FILLED: VenueOrder = {
  ...SAMPLE_OPEN,
  venueOrderId: '2',
  venueClientOrderId: '0x22222222222222222222222222222222',
  type: 'market',
  timeInForce: 'IOC',
  filled: '0.01',
  remaining: '0',
  status: 'filled',
  locked: '0',
};

describe('Activity Orders tab in venue mode', () => {
  it('renders venue open orders with Cancel and venue order history when the venue door is on', () => {
    state.mode = {
      mode: 'on',
      status: {
        enabled: true,
        available: true,
        venue: { id: 'test-sim', displayName: 'TEST venue', proofLevel: 'simulator' },
        test: true,
        chainId: 84532,
        deposit: null,
        builder: null,
      },
      reload: () => undefined,
    };
    state.owner = '0x00000000000000000000000000000000000000a1';
    state.openOrders = [SAMPLE_OPEN];
    state.history = [SAMPLE_FILLED];
    const html = renderToString(<OrdersPanel />);
    expect(html).toContain('data-testid="money-venue-orders"');
    expect(html).toContain('data-testid="venue-open-orders"');
    expect(html).toContain('50,000');
    expect(html).toContain('Cancel');
    expect(html).toContain('data-testid="venue-order-history"');
    expect(html).toContain('/trade/orders/0x22222222222222222222222222222222');
    expect(html).toContain('/trade/orders?product=venue');
  });

  it('keeps the custodial orders panel when the venue door is off', () => {
    state.mode = { mode: 'off' };
    state.owner = null;
    state.openOrders = [];
    state.history = [];
    const html = renderToString(<OrdersPanel />);
    expect(html).not.toContain('money-venue-orders');
    expect(html).toContain('No open orders');
    expect(html).toContain('No past orders');
  });
});
