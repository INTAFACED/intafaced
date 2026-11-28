// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VenueGatedContract, VenueMarket, VenueUp } from '../../../features/trade/venue-api';
import { VenueFuturesDesk } from './VenueFuturesDesk';
import { deskCopy } from './desk-copy';
import { ticketCopy } from './ticket-copy';
import { tabsCopy } from './tabs-copy';
import { positionsCopy } from './positions-copy';
import { triggersCopy } from './triggers-copy';
import { futuresRefusal } from './refusals';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockState: {
  markets: VenueMarket[];
  gated: VenueGatedContract[];
  owner: string | null;
} = {
  markets: [],
  gated: [],
  owner: '0x1111111111111111111111111111111111111111',
};

// The daily loss limit's read (J-derivatives-35) needs a session, which this desk has none of: the limit reads as off.
vi.mock('../../../features/trade/risk/daily-loss-source', async (original) => ({
  ...(await original<typeof import('../../../features/trade/risk/daily-loss-source')>()),
  useDailyLoss: () => ({ status: 'empty' }),
}));
vi.mock('../../../features/protocol/wallet/use-polled', () => ({
  usePolled: (_fn: unknown, key: string) => {
    if (key === 'venue-markets')
      return { data: { asOf: '2026-11-24T00:00:00Z', value: mockState.markets }, failure: null, reload: vi.fn() };
    if (key === 'venue-gated-list')
      return { data: { asOf: '2026-11-24T00:00:00Z', value: mockState.gated }, failure: null, reload: vi.fn() };
    return { data: null, failure: null, reload: vi.fn() };
  },
}));

vi.mock('../../../features/trade/venue/VenueKit', async (original) => {
  const real = await original<typeof import('../../../features/trade/venue/VenueKit')>();
  return {
    ...real,
    VenueFrame: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    WalletBar: () => <div data-testid="venue-wallet" />,
    useOwner: () => mockState.owner,
    useVenueAccount: () => ({
      balances: { data: { asOf: '2026-11-24T00:00:00Z', value: [] }, failure: null, reload: vi.fn() },
      positions: { data: { asOf: '2026-11-24T00:00:00Z', value: [] }, failure: null, reload: vi.fn() },
      openOrders: { data: { asOf: '2026-11-24T00:00:00Z', value: [] }, failure: null, reload: vi.fn() },
      fills: { data: { asOf: '2026-11-24T00:00:00Z', value: [] }, failure: null, reload: vi.fn() },
    }),
    useVenueActions: () => ({ run: vi.fn(), resend: vi.fn() }),
    useVenueApi: () => ({}),
  };
});

vi.mock('../../../features/trade', () => ({
  ActionLimitWarning: () => null,
}));

vi.mock('../../../features/session', () => ({
  useApi: () => ({}),
  // The desk reads the trading session only on a venue whose orders a session key signs (VenueSession.tsx); none here.
  useSession: () => ({ api: {}, userId: null }),
}));

vi.mock('../../../shared/resource', () => ({
  useResource: () => ({ resource: { status: 'loading' }, reload: vi.fn() }),
}));

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

function makePerp(symbol: string): VenueMarket {
  return {
    symbol,
    kind: 'perpetual',
    baseAsset: symbol.split('-')[0]!,
    quoteAsset: 'USDC',
    orderTypes: ['market', 'limit'],
    timeInForce: ['GTC', 'IOC'],
    marginModes: ['isolated'],
    maxLeverageBps: 100000,
    tickSize: '0.1',
    lotSize: '0.01',
    makerFeeBps: { known: true, value: '1' },
    takerFeeBps: { known: true, value: '3' },
    listedBy: { known: true, value: { kind: 'venue', name: 'TEST Venue' } },
    oracleRule: { known: false },
    markRule: { known: false },
    tradingHours: { known: true, value: '24/7' },
    feed: { known: false },
    session: { known: false },
    contractSize: { known: true, value: '1' },
    mark: { known: true, value: '60000' },
    funding: { known: false },
  };
}

let host: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  mockState.markets = [makePerp('BTC-PERP'), makePerp('ETH-PERP'), makePerp('XAU-PERP')];
  mockState.gated = [
    { symbol: 'BTC-PERP', open: true, code: null, message: null, blockers: [] },
    { symbol: 'ETH-PERP', open: true, code: null, message: null, blockers: [] },
    {
      symbol: 'XAU-PERP',
      open: false,
      code: 'trade.venue.market_halted',
      message: 'TEST Venue reports XAU-PERP halted',
      blockers: [{ code: 'trade.venue.market_halted', message: 'TEST Venue reports XAU-PERP halted' }],
    },
  ];
  mockState.owner = '0x1111111111111111111111111111111111111111';
});

afterEach(() => {
  if (root) {
    const mounted = root;
    root = null;
    act(() => mounted.unmount());
  }
  host.remove();
});

function render(node: React.ReactElement) {
  root = createRoot(host);
  const mounted = root;
  act(() => mounted.render(node));
}

describe('/trade/futures compact gating layout and plain copy (#6177)', () => {
  it('omits the empty Contracts panel when perpetuals exist and renders the gated list as one compact strip above the desk', () => {
    render(<VenueFuturesDesk mode={{ mode: 'on', status: STATUS, reload: vi.fn() }} symbol="BTC-PERP" />);

    expect(host.querySelector('[data-testid="venue-contracts"]')).toBeNull();

    const gated = host.querySelector('[data-testid="venue-gated-list"]');
    expect(gated).not.toBeNull();
    const header = gated!.querySelector('.lt-row.lt-row-between');
    expect(header).not.toBeNull();
    expect(header!.querySelector('[data-testid="venue-gated-as-of"]')).not.toBeNull();

    const list = gated!.querySelector('ul');
    expect(list?.className).toContain('lt-toolbar');
    expect(list?.className).not.toContain('lt-stack');

    const gold = gated!.querySelector('[data-testid="venue-gate"][data-symbol="XAU-PERP"]');
    expect(gold?.getAttribute('data-open')).toBe('false');
    expect(gold?.querySelector('[data-code="trade.venue.market_halted"]')?.textContent).toContain('XAU-PERP halted');

    const ticket = host.querySelector('[data-testid="venue-ticket"]');
    expect(ticket).not.toBeNull();
  });

  it('keeps the Contracts empty notice and gated list when no perpetuals are listed', () => {
    mockState.markets = [];
    render(<VenueFuturesDesk mode={{ mode: 'on', status: STATUS, reload: vi.fn() }} symbol={null} />);

    expect(host.querySelector('[data-testid="venue-contracts"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="venue-no-contract"]')?.textContent).toContain('No futures contract is listed');
    expect(host.querySelector('[data-testid="venue-gated-list"]')).not.toBeNull();
  });

  it('uses plain customer wording across futures copy without internal service phrasing', () => {
    const samples = [
      deskCopy.t('Plane off reason'),
      deskCopy.t('No contracts reason'),
      deskCopy.t('Chart no candles reason'),
      deskCopy.t('Risk unknown hint'),
      ticketCopy.t('Unknown figure'),
      ticketCopy.t('Confirm body', { total: '10', asset: 'USDT' }),
      ticketCopy.t('Confirm body unknown'),
      ticketCopy.t('Off not orderable'),
      ticketCopy.t('Off missing figures'),
      ticketCopy.t('No mark reason'),
      tabsCopy.t('Orders footer'),
      tabsCopy.t('History footer'),
      tabsCopy.t('Funding payments reason'),
      tabsCopy.t('Liquidations unavailable reason'),
      positionsCopy.t('Positions mark unavailable'),
      positionsCopy.t('Unknown why maintenance'),
      positionsCopy.t('Unknown why collateral'),
      positionsCopy.t('Unknown why pnl'),
      positionsCopy.t('Margin recompute'),
      positionsCopy.t('Margin reduce note'),
      positionsCopy.t('Leverage cap unknown'),
      positionsCopy.t('Close summary no mark', { contract: 'BTC/USDT:USDT', side: 'Long', size: '0.1' }),
      positionsCopy.t('Detail description'),
      positionsCopy.t('Protect estimate unknown'),
      triggersCopy.t('Cancel other', { reason: 'expired' }),
      futuresRefusal({ code: 'trade.futures_disabled' }).body,
      futuresRefusal({ status: 501 }).body,
      futuresRefusal({ status: 502 }).title,
    ];
    for (const line of samples) {
      expect(line, line).not.toMatch(/\b(the|this|futures|trading) service\b/i);
    }
    expect(futuresRefusal({ code: 'trade.futures_disabled' }).code).toBe('trade.futures_disabled');
  });
});
