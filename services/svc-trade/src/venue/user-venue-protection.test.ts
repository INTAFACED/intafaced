import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { parseAmount, type Amount } from '@intafaced/ledger-client/money';
import type { PlaceUserOrderIntent, PreparedVenueAction, UserVenueMarket, VenueIntent } from '@intafaced/venue-contracts';
import { TradeError } from '../spot/types.js';
import { InMemoryPreparedActionStore } from './prepared-action-store.js';
import { UserVenueRouter } from './venue-router.js';
import { UserVenueDoor, UserVenueDoorError, marketProtectionBound, type ConnectedUserVenue } from './user-venue-door.js';
import { attachUserVenueRoutes } from './user-venue-rest.js';
import { listedTestStore } from './venue-listing-store.js';
import { StoreVenueRoutingGate } from './venue-listing.js';

// J-cex-spot-01: the owner's market price protection (TRADE_MARKET_SLIPPAGE_CAP_BPS) bounds every venue market order on
// the server, on preview and on prepare, not only in the browser. Every figure here is a TEST figure.

const a = parseAmount;
const USER = '11111111-1111-4111-8111-1111111111d1';
const principal = {
  sub: USER,
  userId: USER,
  sid: '33333333-3333-4333-8333-3333333333d3',
  scopes: ['trade:read', 'trade:write'],
  tier: 'basic',
  mfa: false,
  expiresAt: new Date(Date.now() + 600_000),
} as Principal;
const owner = '0x00000000000000000000000000000000000000a1';
const signer = { role: 'owner' as const, address: owner };

const MARKET: UserVenueMarket = {
  symbol: 'BTC-USDC',
  kind: 'spot',
  baseAsset: 'BTC',
  quoteAsset: 'USDC',
  orderTypes: ['limit', 'market'],
  timeInForce: ['GTC', 'IOC', 'ALO'],
  marginModes: [],
  maxLeverageBps: null,
  tickSize: a('1'),
  lotSize: a('0.0001'),
  makerFeeBps: { known: false },
  takerFeeBps: { known: false },
  status: null,
  maxOrderQty: null,
  maxOrderNotional: null,
  builderFeeCapBps: { known: false },
  listedBy: { known: false },
  oracleRule: { known: false },
  markRule: { known: false },
  tradingHours: { known: false },
  feed: { known: false },
};

const PERP: UserVenueMarket = { ...MARKET, symbol: 'BTC-PERP', kind: 'perpetual', marginModes: ['cross'], maxLeverageBps: 100_000 };

/** A TEST venue that records what it was asked to preview and prepare, with a book the test sets. */
function stubVenue(best: { bid: Amount | null; ask: Amount | null }) {
  const asked = { previews: 0, prepares: 0 };
  const venueId = 'stub';
  const at = () => new Date();
  const venue = {
    venue: { id: venueId, displayName: 'stub TEST venue', kind: 'external-dex', sequencedDepth: true, proofLevel: 'simulator' },
    markets: async () => ({ venueId, value: [MARKET, PERP], asOf: at() }),
    bestPrices: async (symbol: string) => ({ venueId, value: { symbol, ...best }, asOf: at() }),
    preview: async () => {
      asked.previews += 1;
      return { venueId, value: { role: 'taker' }, asOf: at() };
    },
    prepare: async (account: unknown, s: unknown, intent: VenueIntent): Promise<PreparedVenueAction> => {
      asked.prepares += 1;
      return {
        venueId,
        account: account as PreparedVenueAction['account'],
        signer: s as PreparedVenueAction['signer'],
        intent,
        nonce: String(asked.prepares),
        venueClientOrderId: `cid-${asked.prepares}`,
        typedData: {},
        digest: `0x${asked.prepares.toString(16).padStart(4, '0')}`,
        builderFee: null,
        preparedAt: at(),
      };
    },
  } as unknown as ConnectedUserVenue;
  return { venue, asked };
}

function door(slippageCapBps: number | null, best = { bid: a('59990') as Amount | null, ask: a('60010') as Amount | null }) {
  const { venue, asked } = stubVenue(best);
  const d = new UserVenueDoor({
    connect: async () => venue,
    appEnv: 'test',
    store: new InMemoryPreparedActionStore(),
    stepUp: { require: async () => ({ stepUpEventId: 'x', consumedAt: null, replayed: false }) },
    builder: { address: '0x00000000000000000000000000000000000000b1', feeBps: a('1') },
    slippageCapBps,
    now: () => new Date(),
    // Our listing shows the one market these orders use (J-cex-spot-16).
    listings: new StoreVenueRoutingGate(listedTestStore(['BTC-USDC', 'BTC-PERP'], 'stub')),
  });
  return { d, asked };
}

let n = 0;
const order = (over: Partial<PlaceUserOrderIntent> = {}): PlaceUserOrderIntent => ({
  kind: 'place_order',
  symbol: 'BTC-USDC',
  side: 'buy',
  type: 'market',
  amount: a('0.1'),
  price: a('60311'),
  timeInForce: 'IOC',
  reduceOnly: false,
  clientOrderKey: `order:${USER}:protection-test:${(n += 1)}`,
  builderFee: null,
  ...over,
});

async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof TradeError || error instanceof UserVenueDoorError) return error.code;
    throw error;
  }
  return 'passed';
}

describe('marketProtectionBound: the same rounding as the desk', () => {
  it('a buy is the best ask plus the cap rounded up to the tick; a sell the best bid less the cap rounded down', () => {
    // 60010 × 1.005 = 60310.05 → 60311; 59990 × 0.995 = 59690.05 → 59690.
    expect(marketProtectionBound('buy', { bid: a('59990'), ask: a('60010') }, 50, a('1'))).toBe(a('60311'));
    expect(marketProtectionBound('sell', { bid: a('59990'), ask: a('60010') }, 50, a('1'))).toBe(a('59690'));
    expect(marketProtectionBound('buy', { bid: a('1'), ask: null }, 50, a('1'))).toBeNull();
    expect(marketProtectionBound('sell', { bid: null, ask: a('1') }, 50, a('1'))).toBeNull();
  });
});

describe('the door bounds every venue market order by the owner protection', () => {
  it("a perpetual's market order is not bounded by it: the futures ticket's own worst price goes to the venue as typed", async () => {
    // Past the spot bound (60311) and with the protection blank: the venue is asked, on preview and prepare.
    const { d, asked } = door(null);
    const perp = order({ symbol: 'BTC-PERP', price: a('62000') });
    expect(await refusal(() => d.preview(principal, owner, perp))).toBe('passed');
    expect(asked.previews).toBe(1);
  });

  it('blank cap: a market order refuses trade.slippage_cap_unset on preview and prepare, and the venue is never asked', async () => {
    const { d, asked } = door(null);
    expect(await refusal(() => d.preview(principal, owner, order()))).toBe('trade.slippage_cap_unset');
    expect(await refusal(() => d.prepare(principal, { owner, signer, intent: order() }))).toBe('trade.slippage_cap_unset');
    expect(asked).toEqual({ previews: 0, prepares: 0 });
  });

  it('a buy past the bound refuses trade.venue.price_outside_protection on preview and prepare; nothing is prepared', async () => {
    const { d, asked } = door(50);
    const over = order({ price: a('60312') });
    expect(await refusal(() => d.preview(principal, owner, over))).toBe('trade.venue.price_outside_protection');
    expect(await refusal(() => d.prepare(principal, { owner, signer, intent: over }))).toBe('trade.venue.price_outside_protection');
    expect(asked).toEqual({ previews: 0, prepares: 0 });
  });

  it('a buy at the bound passes preview and prepare', async () => {
    const { d, asked } = door(50);
    expect(await refusal(() => d.preview(principal, owner, order({ price: a('60311') })))).toBe('passed');
    const prepared = await d.prepare(principal, { owner, signer, intent: order({ price: a('60311') }) });
    expect(prepared.reused).toBe(false);
    expect(asked).toEqual({ previews: 1, prepares: 1 });
  });

  it('a sell below the bound refuses; at the bound it passes', async () => {
    const { d } = door(50);
    expect(await refusal(() => d.preview(principal, owner, order({ side: 'sell', price: a('59689') })))).toBe(
      'trade.venue.price_outside_protection',
    );
    expect(await refusal(() => d.preview(principal, owner, order({ side: 'sell', price: a('59690') })))).toBe('passed');
  });

  it('no price on the side the order meets refuses trade.no_reference_price: never an unbounded order', async () => {
    const { d, asked } = door(50, { bid: a('59990'), ask: null });
    expect(await refusal(() => d.prepare(principal, { owner, signer, intent: order() }))).toBe('trade.no_reference_price');
    expect(asked.prepares).toBe(0);
  });

  it('a limit order is not bounded by it, even with the cap blank', async () => {
    const { d } = door(null);
    const limit = order({ type: 'limit', timeInForce: 'GTC', price: a('70000') });
    expect(await refusal(() => d.preview(principal, owner, limit))).toBe('passed');
    expect((await d.prepare(principal, { owner, signer, intent: limit })).reused).toBe(false);
  });
});

describe('POST /api/v1/venue/preview and /prepare answer the protection refusals typed', () => {
  let app: FastifyInstance;
  afterEach(async () => app?.close());

  async function mount(cap: number | null) {
    app = Fastify();
    attachUserVenueRoutes(
      app,
      new UserVenueRouter({ doors: [door(cap).d], store: new InMemoryPreparedActionStore(), now: () => new Date() }),
      {
        requirePrincipal: () => principal,
        requireTradeJurisdiction: () => true,
        slippageCapBps: cap,
      },
    );
    await app.ready();
    return app;
  }
  const wire = (intent: PlaceUserOrderIntent) => ({
    ...intent,
    amount: '0.1',
    price: String(intent.price / 10n ** 18n),
  });

  it('blank cap answers 503 ExchangeNotAvailable trade.slippage_cap_unset, the custodial path’s shape', async () => {
    await mount(null);
    const res = await app.inject({ method: 'POST', url: '/api/v1/venue/preview', payload: { owner, intent: wire(order()) } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'ExchangeNotAvailable', intafacedCode: 'trade.slippage_cap_unset' });
  });

  it('a buy past the bound answers 422 InvalidOrder trade.venue.price_outside_protection', async () => {
    await mount(50);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/venue/prepare',
      payload: { owner, signer, intent: wire(order({ price: a('60400') })) },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'InvalidOrder', intafacedCode: 'trade.venue.price_outside_protection' });
  });
});
