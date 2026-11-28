// @vitest-environment happy-dom
// A market order's worst price is never a limit price left over from the ticket's Limit tab, sent silently
// while the review names only the slippage cap. Switching to Market re-fills the field from the best price and the cap
// (the bound svc-trade itself puts on a market order, `slippageLimit`); a worst price on the wrong side of the market
// is refused before anything is sent; and the review names the worst price the order goes at.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VenueMarket, VenueUp } from '../../../features/trade/venue-api';
import { VenueFuturesDesk } from './VenueFuturesDesk';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { ASOF, mockState, preview, bestPrices } = vi.hoisted(() => ({
  ASOF: '2026-11-25T00:00:00Z',
  mockState: { markets: [], best: { bid: '89990', ask: '90000' } } as {
    markets: VenueMarket[];
    best: { bid: string | null; ask: string | null };
  },
  preview: vi.fn(),
  bestPrices: vi.fn(),
}));

// The daily loss limit's read (J-derivatives-35) needs a session, which this desk has none of: the limit reads as off.
vi.mock('../../../features/trade/risk/daily-loss-source', async (original) => ({
  ...(await original<typeof import('../../../features/trade/risk/daily-loss-source')>()),
  useDailyLoss: () => ({ status: 'empty' }),
}));
vi.mock('../../../features/protocol/wallet/use-polled', () => ({
  usePolled: (_fn: unknown, key: string) => {
    if (key === 'venue-markets') return { data: { asOf: ASOF, value: mockState.markets }, failure: null, reload: vi.fn() };
    if (key === 'venue-gated-list')
      return {
        data: { asOf: ASOF, value: [{ symbol: 'BTC-PERP', open: true, code: null, message: null, blockers: [] }] },
        failure: null,
        reload: vi.fn(),
      };
    if (key === 'best:BTC-PERP')
      return {
        data: {
          asOf: ASOF,
          value: { symbol: 'BTC-PERP', ...mockState.best },
          slippageCapBps: { known: true, value: '50' },
        },
        failure: null,
        reload: vi.fn(),
      };
    return { data: null, failure: null, reload: vi.fn() };
  },
}));

vi.mock('../../../features/trade/venue/VenueKit', async (original) => {
  const real = await original<typeof import('../../../features/trade/venue/VenueKit')>();
  const empty = { data: { asOf: ASOF, value: [] }, failure: null, reload: vi.fn() };
  return {
    ...real,
    VenueFrame: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    WalletBar: () => <div data-testid="venue-wallet" />,
    useOwner: () => '0x1111111111111111111111111111111111111111',
    useVenueAccount: () => ({ balances: empty, positions: empty, openOrders: empty, fills: empty, reload: vi.fn() }),
    useVenueActions: () => ({ run: vi.fn(), resend: vi.fn() }),
    useVenueApi: () => ({ preview, bestPrices }),
  };
});
vi.mock('../../../features/trade', () => ({ ActionLimitWarning: () => null }));
vi.mock('../../../features/session', () => ({ useApi: () => ({}), useSession: () => ({ api: {}, userId: null }) }));
vi.mock('../../../shared/resource', () => ({ useResource: () => ({ resource: { status: 'loading' }, reload: vi.fn() }) }));
vi.mock('./VenueAccount', () => ({ VenueAccount: () => null }));
vi.mock('./VenueFunding', () => ({ VenueFunding: () => null }));
vi.mock('./VenueRisk', () => ({ VenueCollateral: () => null, VenueTiers: () => null }));
vi.mock('./VenueRoutes', () => ({ RoutedReview: () => null, VenueRoutes: () => null }));

const STATUS: VenueUp = {
  enabled: true,
  available: true,
  venue: { id: 'hyperliquid', displayName: 'TEST Venue', proofLevel: 'simulator' },
  chainId: 84532,
  builder: null,
  test: true,
  routes: false,
};

const BTC: VenueMarket = {
  symbol: 'BTC-PERP',
  kind: 'perpetual',
  baseAsset: 'BTC',
  quoteAsset: 'USDC',
  orderTypes: ['market', 'limit'],
  timeInForce: ['GTC', 'IOC'],
  marginModes: ['isolated'],
  maxLeverageBps: 100000,
  tickSize: '1',
  lotSize: '0.001',
  makerFeeBps: { known: true, value: '1' },
  takerFeeBps: { known: true, value: '3' },
  listedBy: { known: true, value: { kind: 'venue', name: 'TEST Venue' } },
  oracleRule: { known: false },
  markRule: { known: false },
  tradingHours: { known: true, value: '24/7' },
  feed: { known: false },
  session: { known: false },
  contractSize: { known: true, value: '1' },
  mark: { known: true, value: '90000' },
  funding: { known: false },
};

let host: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  mockState.markets = [BTC];
  mockState.best = { bid: '89990', ask: '90000' };
  preview.mockReset();
  // The review reads the best price fresh: here it answers as the poll does.
  bestPrices.mockReset();
  bestPrices.mockImplementation(async () => ({
    ok: true,
    data: { asOf: ASOF, value: { symbol: 'BTC-PERP', ...mockState.best }, slippageCapBps: { known: true, value: '50' } },
  }));
  preview.mockResolvedValue({
    ok: true,
    data: {
      asOf: ASOF,
      value: {
        symbol: 'BTC-PERP',
        kind: 'perpetual',
        lock: { asset: 'USDC', amount: '9.045' },
        role: 'taker',
        venueFee: { known: true, value: { asset: 'USDC', amount: '0.027' } },
        builderFee: { known: true, value: { asset: 'USDC', amount: '0' } },
        perpetual: {
          leverageBps: 100000,
          marginMode: 'isolated',
          initialMargin: { known: true, value: '9.045' },
          liquidationPrice: { known: false },
        },
      },
    },
  });
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

const ticket = () => host.querySelector<HTMLElement>('[data-testid="venue-ticket"]')!;
const field = (label: string) => ticket().querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const button = (scope: HTMLElement, text: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text)!;

function type(input: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function press(b: HTMLButtonElement) {
  await act(async () => {
    b.click();
  });
}
const typesGroup = () => ticket().querySelector<HTMLElement>('[data-testid="venue-order-types"]')!;

describe('the futures ticket never sends a worst price left over from a limit order', () => {
  it('re-fills the worst price from the best ask plus the 50 bps cap when the ticket switches from Limit to Market', async () => {
    render();
    await press(button(typesGroup(), 'Limit'));
    type(field('Price'), '20000');
    await press(button(typesGroup(), 'Market'));
    // 90000 × (1 + 0.005) = 90450, on the 1 tick: the bound svc-trade puts on a market buy.
    expect(field('Worst price (slippage limit)').value).toBe('90450');
  });

  it('refuses a market buy whose worst price sits below the best ask, and sends nothing', async () => {
    render();
    await press(button(typesGroup(), 'Market'));
    type(field('Size (BTC)'), '0.001');
    type(field('Worst price (slippage limit)'), '20000');
    await press(button(ticket(), 'Review long'));
    const refusal = ticket().querySelector('[role="alert"][data-code="trade.venue.worst_price_wrong_side"]');
    expect(refusal?.textContent).toBe(
      'A market buy’s worst price, 20,000 USDC, is below the best ask of 90,000 USDC, so it cannot fill. Raise it, or use a limit order. Nothing was sent.',
    );
    expect(preview).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="venue-review"]')).toBeNull();
  });

  it('names the worst price the market order goes at in its review, beside the slippage cap', async () => {
    render();
    await press(button(typesGroup(), 'Market'));
    type(field('Size (BTC)'), '0.001');
    await press(button(ticket(), 'Review long'));
    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview.mock.calls[0]![1]).toMatchObject({ type: 'market', price: '90450', timeInForce: 'IOC' });
    const review = document.querySelector<HTMLElement>('[data-testid="venue-review"]')!;
    expect(review.querySelector('[data-line="worst-price"]')?.textContent).toBe('90,450 USDC');
    expect(review.querySelector('[data-line="slippage-cap"]')?.textContent).toBe('50 bps');
  });

  it('re-fills the worst price from the best bid less the cap when a market order turns to Short, and refuses one above the bid', async () => {
    render();
    await press(button(typesGroup(), 'Market'));
    await press(button(ticket(), 'Short'));
    // 89990 × (1 − 0.005) = 89540.05, up toward the market on the venue's price rule: the bound on a market sell.
    expect(field('Worst price (slippage limit)').value).toBe('89541');
    type(field('Size (BTC)'), '0.001');
    type(field('Worst price (slippage limit)'), '95000');
    await press(button(ticket(), 'Review short'));
    const refusal = ticket().querySelector('[role="alert"][data-code="trade.venue.worst_price_wrong_side"]');
    expect(refusal?.textContent).toBe(
      'A market sell’s worst price, 95,000 USDC, is above the best bid of 89,990 USDC, so it cannot fill. Lower it, or use a limit order. Nothing was sent.',
    );
    expect(preview).not.toHaveBeenCalled();
  });

  it('with no fresh best price, refuses nothing it cannot check and still names the worst price it sends', async () => {
    render();
    bestPrices.mockResolvedValue({ ok: false, message: 'TEST Venue did not answer', code: 'trade.venue.unavailable' });
    await press(button(typesGroup(), 'Market'));
    type(field('Size (BTC)'), '0.001');
    type(field('Worst price (slippage limit)'), '91000');
    await press(button(ticket(), 'Review long'));
    expect(ticket().querySelector('[data-code="trade.venue.worst_price_wrong_side"]')).toBeNull();
    expect(preview.mock.calls[0]![1]).toMatchObject({ type: 'market', price: '91000' });
    const review = document.querySelector<HTMLElement>('[data-testid="venue-review"]')!;
    expect(review.querySelector('[data-line="worst-price"]')?.textContent).toBe('91,000 USDC');
  });
});
