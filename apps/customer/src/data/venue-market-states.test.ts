import { describe, expect, it } from 'vitest';
import { venueListingOf, venueListingStatuses, venueMarketRow, venueModeOf, type VenueMarketState } from './venue-market-states';
import { pickSource } from '../screens/trade/markets/source';
import { modesFrom, type MarketMode } from '../features/public/status';
import type { Loadable, MarketRow } from './types';

// J-cex-spot-14 #1 #2: a venue market's mode and its row on the markets list come from the venue's own state with our
// listing beside it; where the venue door is off the screens keep today's reads, and a venue that does not answer is
// never stood in for by our own book. TEST figures.

const OPENS = '2026-11-24T09:00:00.000Z';
function market(over: Partial<VenueMarketState> = {}, listing: Partial<VenueMarketState['listing']> = {}): VenueMarketState {
  return {
    symbol: 'BTC-USDC',
    kind: 'spot',
    baseAsset: 'BTC',
    quoteAsset: 'USDC',
    tickSize: '0.1',
    lotSize: '0.001',
    status: 'trading',
    session: { known: false },
    ...over,
    listing: { opensAt: OPENS, delistsAt: null, routing: 'show', open: true, delisted: false, ...listing },
  };
}

describe('venueModeOf', () => {
  it.each([
    ['open and trading', market(), 'OPEN'],
    ['the venue halted it', market({ status: 'halted' }), 'HALTED'],
    ['the venue takes limit orders only', market({ status: 'limit_only' }), 'LIMIT_ONLY'],
    ['the venue takes cancels only', market({ status: 'cancel_only' }), 'CANCEL_ONLY'],
    [
      'the venue spot session is closed',
      market({
        session: {
          known: true,
          value: {
            state: 'closed',
            homeMarket: 'TEST',
            offHoursMode: { known: false },
            offHoursBand: { known: false },
            offHoursMaxLeverageBps: null,
            reopensAt: '2026-11-24T12:00:00.000Z',
            offHoursRule: { known: false },
          },
        },
      }),
      'HALTED',
    ],
    ['the venue delisted it', market({ status: 'delisted' }), 'DELISTING'],
    ['our delisting date passed', market({}, { delisted: true, delistsAt: OPENS }), 'DELISTING'],
    ['we stopped routing', market({}, { routing: 'stop' }), 'HALTED'],
    ['we route closing orders only', market({}, { routing: 'close_only' }), 'REDUCE_ONLY'],
    ['our listing has not opened', market({}, { open: false }), 'PRELAUNCH'],
    ['our stop wins over a trading venue', market({ status: 'trading' }, { routing: 'stop' }), 'HALTED'],
    ['the venue cancel-only wins over our close-only', market({ status: 'cancel_only' }, { routing: 'close_only' }), 'CANCEL_ONLY'],
  ] as const)('%s', (_name, m, mode) => expect(venueModeOf(m)).toBe(mode));

  it('is null, never open, where the venue reports no state', () => {
    expect(venueModeOf(market({ status: null }))).toBeNull();
  });
});

describe('venueMarketRow', () => {
  it('trades only an open market with no delisting set, keyed by the venue symbol', () => {
    const row = venueMarketRow(market());
    expect(row).toMatchObject({ symbol: 'BTC-USDC', base: 'BTC', quote: 'USDC', orderable: true, listing: 'open', delistsAt: null });
  });
  it('names an upcoming listing and a dated delisting, and neither trades', () => {
    expect(venueMarketRow(market({}, { open: false }))).toMatchObject({ orderable: false, listing: 'upcoming' });
    const delisting = venueMarketRow(market({}, { delistsAt: '2026-12-01T00:00:00.000Z' }));
    expect(delisting).toMatchObject({ orderable: false, listing: 'delisting', delistsAt: '2026-12-01T00:00:00.000Z' });
  });
  it('pauses a market the venue halted or takes cancels only on, and leaves an unknown venue status open on an open listing', () => {
    for (const status of ['halted', 'cancel_only'] as const)
      expect(venueMarketRow(market({ status }))).toMatchObject({ orderable: false, listing: 'halted' });
    expect(venueMarketRow(market({ status: null }))).toMatchObject({ orderable: true, listing: 'open' });
    expect(venueMarketRow(market({ status: null }, { routing: 'stop' }))).toMatchObject({ orderable: false, listing: 'halted' });
    expect(venueMarketRow(market({ status: null }, { routing: 'close_only' }))).toMatchObject({ orderable: false, listing: 'halted' });
    expect(venueListingOf(market({ status: 'delisted' }))).toBe('delisted');
  });
});

const states = (markets: VenueMarketState[]) =>
  ({
    status: 'ready',
    asOf: 1,
    data: {
      venueId: 'test-venue-sim',
      asOf: '2026-11-24T10:00:00.000Z',
      value: { venue: { id: 'v', displayName: 'TEST' }, markets, test: true },
    },
  }) as const;
const ownRow = (base: string, quote: string): MarketRow => ({
  symbol: `${base}/${quote}`,
  base,
  quote,
  orderable: true,
  tickSize: '0.01',
  lotSize: '0.0001',
  minAmount: null,
  listedAt: null,
});
const own: Loadable<MarketRow[]> = { status: 'ready', asOf: 1, data: [] };

describe('pickSource (the markets list)', () => {
  it('merges venue spot markets with non-overlapping API spot markets, keeps venue state on overlap, and aligns slash tickers', () => {
    const btcTicker = {
      symbol: 'BTC/USDC',
      last: '65213.84',
      bid: null,
      ask: null,
      open24h: '64000.00',
      high24h: '66000.00',
      low24h: '63500.00',
      change24h: '1213.84',
      changePct24h: '0.0189',
      baseVolume24h: '10',
      quoteVolume24h: '650000',
      windowStart: null,
      source: 'server' as const,
    };
    const picked = pickSource(
      states([market({ status: null }), market({ symbol: 'BTC-PERP', kind: 'perpetual' })]),
      { status: 'ready', asOf: 2, data: [ownRow('BTC', 'USDC'), ownRow('ETH', 'USDT')] },
      { status: 'ready', asOf: 3, data: { 'BTC/USDC': btcTicker } },
    );
    expect(picked.markets.status === 'ready' && picked.markets.data.map((m) => m.symbol)).toEqual(['BTC-USDC', 'ETH/USDT']);
    expect(picked.tickers.status).toBe('ready');
    if (picked.tickers.status === 'ready') {
      expect(picked.tickers.data['BTC-USDC']?.last).toBe('65213.84');
      expect(picked.tickers.data['BTC/USDC']?.last).toBe('65213.84');
    }
  });
  it('keeps the own read where the venue door is off, and shows the venue read otherwise', () => {
    const tickers = { status: 'ready', asOf: 1, data: {} } as const;
    expect(pickSource({ status: 'refused', code: 'trade.user_venue_off' }, own, tickers)).toEqual({ markets: own, tickers });
    expect(pickSource({ status: 'refused', code: 'trade.venue.venue_down' }, own, tickers).markets).toEqual({
      status: 'refused',
      code: 'trade.venue.venue_down',
    });
    expect(pickSource({ status: 'loading' }, own, tickers).markets.status).toBe('loading');
    expect(pickSource(states([market()]), { status: 'loading' }, tickers).markets.status).toBe('loading');
  });
});

describe('modesFrom (/status)', () => {
  const ownModes: Loadable<MarketMode[]> = { status: 'ready', asOf: 1, data: [] };
  it("gives every listed venue market its mode, as of the venue read's time", () => {
    const load = modesFrom(states([market(), market({ symbol: 'ETH-PERP', kind: 'perpetual', status: 'cancel_only' })]), ownModes);
    expect(load.status === 'ready' && load.data).toEqual([
      { symbol: 'BTC-USDC', state: 'OPEN', reasonCode: null, observedAt: '2026-11-24T10:00:00.000Z', maintenance: null },
      { symbol: 'ETH-PERP', state: 'CANCEL_ONLY', reasonCode: null, observedAt: '2026-11-24T10:00:00.000Z', maintenance: null },
    ]);
  });
  it('keeps the own read only where the venue door is off', () => {
    expect(modesFrom({ status: 'refused', code: 'trade.user_venue_off' }, ownModes)).toBe(ownModes);
    expect(modesFrom({ status: 'error', retry: () => undefined }, ownModes).status).toBe('error');
  });

  it('maps upcomingMaintenance and closed session into modesFrom and venueListingStatuses', () => {
    const maint = {
      status: 'scheduled' as const,
      noticeId: 'n1',
      title: 'TEST maintenance',
      startsAt: '2026-11-24T11:00:00.000Z',
      endsAt: null,
    };
    const closed = market({
      symbol: 'SHUT-USDC',
      session: {
        known: true,
        value: {
          state: 'closed',
          homeMarket: 'TEST',
          offHoursMode: { known: false },
          offHoursBand: { known: false },
          offHoursMaxLeverageBps: null,
          reopensAt: '2026-11-24T12:00:00.000Z',
          offHoursRule: { known: false },
        },
      },
      upcomingMaintenance: maint,
    });
    const s = states([closed]);
    const load = modesFrom(s, ownModes);
    expect(load.status === 'ready' && load.data[0]?.maintenance).toEqual({
      status: 'scheduled',
      startsAt: Date.parse(maint.startsAt),
      endsAt: null,
    });
    expect(venueListingStatuses(s.data)['SHUT-USDC']).toMatchObject({
      separateFromSpot: false,
      sessionOpen: false,
      opensAt: Date.parse('2026-11-24T12:00:00.000Z'),
      maintenance: { status: 'scheduled', endsAt: null },
    });
  });
});
