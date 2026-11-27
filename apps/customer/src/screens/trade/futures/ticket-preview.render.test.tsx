// @vitest-environment happy-dom
// #11106: a trader with no wallet connected (so no trading session) pressed Long or Short on the futures desk and saw
// nothing: no size, leverage, margin or fee. The desk shows the order form with the venue's fee rates and one clear
// action, connect the wallet, before any session exists. The figures below are TEST.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VenueMarket, VenueUp } from '../../../features/trade/venue-api';
import { VenueFuturesDesk } from './VenueFuturesDesk';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const world = vi.hoisted(() => ({
  markets: [] as unknown[],
  wallets: [] as { info: { uuid: string; name: string } }[],
  connect: vi.fn(),
}));

vi.mock('../../../features/protocol/wallet/use-polled', () => ({
  usePolled: (_fn: unknown, key: string) => {
    if (key === 'venue-markets') return { data: { asOf: '2026-11-27T00:00:00Z', value: world.markets }, failure: null, reload: vi.fn() };
    if (key.startsWith('best:'))
      return {
        data: { asOf: '2026-11-27T00:00:00Z', value: { symbol: 'BTC-PERP', bid: '62600', ask: '62620' }, slippageCapBps: { known: false } },
        failure: null,
        reload: vi.fn(),
      };
    return { data: null, failure: null, reload: vi.fn() };
  },
}));

vi.mock('../../../features/protocol', async (original) => {
  const real = await original<typeof import('../../../features/protocol')>();
  return {
    ...real,
    useWallet: () => ({ status: 'disconnected', address: null, wallets: world.wallets, connect: world.connect, problem: null }),
  };
});

vi.mock('../../../features/trade/venue/VenueKit', async (original) => {
  const real = await original<typeof import('../../../features/trade/venue/VenueKit')>();
  return {
    ...real,
    VenueFrame: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    WalletBar: () => <div data-testid="venue-wallet" />,
    useOwner: () => null,
    useVenueAccount: () => ({
      balances: { data: null, failure: null, reload: vi.fn() },
      positions: { data: null, failure: null, reload: vi.fn() },
      openOrders: { data: null, failure: null, reload: vi.fn() },
      fills: { data: null, failure: null, reload: vi.fn() },
    }),
    useVenueActions: () => ({ run: vi.fn(), resend: vi.fn() }),
    useVenueApi: () => ({}),
  };
});

vi.mock('../../../features/trade', () => ({ ActionLimitWarning: () => null }));
vi.mock('../../../features/session', () => ({ useApi: () => ({}), useSession: () => ({ api: {}, userId: 'u1' }) }));
vi.mock('../../../shared/resource', () => ({ useResource: () => ({ resource: { status: 'loading' }, reload: vi.fn() }) }));
vi.mock('./VenueAccount', () => ({ VenueAccount: () => null }));
vi.mock('./VenueFunding', () => ({ VenueFunding: () => null }));
vi.mock('./VenueRisk', () => ({ VenueCollateral: () => null, VenueTiers: () => null }));
vi.mock('./VenueRoutes', () => ({ RoutedReview: () => null, VenueRoutes: () => null }));
vi.mock('../desk/VenueMarketData', () => ({ VenueMarketPanel: () => null }));

const STATUS: VenueUp = {
  enabled: true,
  available: true,
  venue: { id: 'hyperliquid', displayName: 'TEST Venue', proofLevel: 'testnet' },
  chainId: 421614,
  builder: null,
  test: true,
  routes: false,
  tradesSignedBy: 'session_key',
};

const BTC: VenueMarket = {
  symbol: 'BTC-PERP',
  kind: 'perpetual',
  baseAsset: 'BTC',
  quoteAsset: 'USDC',
  orderTypes: ['limit', 'market'],
  timeInForce: ['GTC', 'IOC'],
  marginModes: ['cross', 'isolated'],
  maxLeverageBps: 400000,
  tickSize: '1',
  lotSize: '0.00001',
  makerFeeBps: { known: true, value: '1.5' },
  takerFeeBps: { known: true, value: '4.5' },
  listedBy: { known: false },
  oracleRule: { known: false },
  markRule: { known: false },
  tradingHours: { known: false },
  feed: { known: false },
  session: { known: false },
  contractSize: { known: true, value: '1' },
  mark: { known: true, value: '62620' },
  funding: { known: false },
};

let host: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  world.markets = [BTC];
  world.wallets = [];
  world.connect.mockReset();
});

afterEach(() => {
  if (root) {
    const mounted = root;
    root = null;
    act(() => mounted.unmount());
  }
  host.remove();
});

function render() {
  root = createRoot(host);
  const mounted = root;
  act(() => mounted.render(<VenueFuturesDesk mode={{ mode: 'on', status: STATUS, reload: vi.fn() }} symbol="BTC-PERP" />));
}

function type(label: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(`[data-testid="venue-ticket-preview"] input[aria-label="${label}"]`);
  expect(input, label).not.toBeNull();
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(input, value);
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('#11106 the futures order form before any wallet or session', () => {
  it('shows size, leverage, the order value, margin and fee at the venue rates, and one action: make a wallet', () => {
    render();
    const form = host.querySelector('[data-testid="venue-ticket-preview"]');
    expect(form).not.toBeNull();
    expect(form!.textContent).toContain('Long');
    expect(form!.textContent).toContain('Short');
    type('Size (BTC)', '0.01');
    type('Leverage (times)', '5');
    const summary = form!.querySelector('[data-testid="venue-ticket-preview-summary"]')!.textContent;
    // 0.01 BTC at the best ask 62,620: 626.2 USDC; at 5x, 125.24 margin; at the 4.5 bps taker rate, 0.28179 fee.
    expect(summary).toContain('626.2');
    expect(summary).toContain('Margin at 5x');
    expect(summary).toContain('125.24');
    expect(summary).toContain('0.28179');
    expect(form!.querySelector('[data-testid="venue-ticket-preview-fees"]')!.textContent).toContain('0.045%');
    expect(form!.querySelector('[data-testid="venue-ticket-preview-fees"]')!.textContent).toContain('0.015%');
    // The one action: no wallet in this browser, so make one; nothing claims an order can be placed yet.
    const actions = form!.querySelectorAll('[data-testid="venue-ticket-preview-go"]');
    expect(actions).toHaveLength(1);
    expect(actions[0]!.getAttribute('href')).toBe('/wallet/embedded');
    expect(form!.textContent).toContain('start a trading session');
  });

  it('with a wallet in this browser, the one action connects it', () => {
    world.wallets = [{ info: { uuid: 'w1', name: 'INTAFACED wallet' } }];
    render();
    const go = host.querySelector<HTMLButtonElement>('[data-testid="venue-ticket-preview-go"]');
    expect(go?.textContent).toContain('INTAFACED wallet');
    act(() => go!.click());
    expect(world.connect).toHaveBeenCalledWith(world.wallets[0]);
  });

  it('leverage above the venue maximum is refused in words, and the summary waits', () => {
    render();
    type('Size (BTC)', '0.01');
    type('Leverage (times)', '41');
    const form = host.querySelector('[data-testid="venue-ticket-preview"]')!;
    expect(form.querySelector('[role="alert"]')?.textContent).toContain('40x');
    expect(form.querySelector('[data-testid="venue-ticket-preview-summary"]')!.textContent).not.toContain('Margin at 41x');
  });
});
