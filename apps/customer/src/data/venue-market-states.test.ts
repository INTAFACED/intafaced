import { describe, expect, it } from 'vitest';
import {
  venueListingOf,
  venueListingStatuses,
  venueMarketRow,
  venueModeOf,
  venueTickerRow,
  type VenueMarketState,
} from './venue-market-states';
import { listedCount, pickSource, venueSpotMarkets } from './market-catalogue';
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
  it('pauses a market the venue halted, takes cancels only on, or reports no state for', () => {
    for (const status of ['halted', 'cancel_only', null] as const)
      expect(venueMarketRow(market({ status }))).toMatchObject({ orderable: false, listing: 'halted' });
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
const own: Loadable<MarketRow[]> = { status: 'ready', asOf: 1, data: [] };

describe('pickSource (the one markets catalogue: Markets, Home, Home Pro)', () => {
  const noPrices = { status: 'empty' } as const;
  const venuePrices = {
    status: 'ready',
    asOf: 2,
    data: {
      venueId: 'test-venue-sim',
      asOf: '2026-11-24T10:00:00.000Z',
      test: true,
      value: {
        'BTC-USDC': {
          symbol: 'BTC-USDC',
          last: '97000.5',
          high: '98000',
          low: '96000',
          baseVolume: '12.5',
          quoteVolume: '1212500',
          bid: '97000',
          ask: '97001',
          spread: '1',
        },
      },
    },
  } as const;
  it("lists the venue's spot markets with the venue's own prices, never our own book's", () => {
    const ownPrices = { status: 'ready', asOf: 1, data: { 'BTC-USDC': { symbol: 'BTC-USDC' } as never } } as const;
    const picked = pickSource(states([market(), market({ symbol: 'BTC-PERP', kind: 'perpetual' })]), own, ownPrices, venuePrices);
    expect(picked.markets.status === 'ready' && picked.markets.data.map((m) => m.symbol)).toEqual(['BTC-USDC']);
    // The perpetuals stand apart, so a room lists them only on purpose (the landing's Perps tab).
    expect(picked.perpetuals.status === 'ready' && picked.perpetuals.data.map((m) => m.symbol)).toEqual(['BTC-PERP']);
    // Home reads this source too, and shows none of our own engine's movers beside the venue's markets.
    expect(picked.source).toBe('venue');
    expect(picked.tickers).toEqual({
      status: 'ready',
      asOf: 2,
      data: {
        'BTC-USDC': {
          symbol: 'BTC-USDC',
          last: '97000.5',
          bid: '97000',
          ask: '97001',
          open24h: null,
          high24h: '98000',
          low24h: '96000',
          change24h: null,
          changePct24h: null,
          baseVolume24h: '12.5',
          quoteVolume24h: '1212500',
          windowStart: null,
          source: 'server',
        },
      },
    });
  });
  it("shows no prices while the venue's price read loads, refuses or fails", () => {
    const listed = states([market()]);
    expect(pickSource(listed, own, { status: 'ready', asOf: 1, data: {} }, noPrices).tickers.status).toBe('empty');
    expect(pickSource(listed, own, { status: 'ready', asOf: 1, data: {} }, { status: 'loading' }).tickers.status).toBe('loading');
    expect(
      pickSource(listed, own, { status: 'ready', asOf: 1, data: {} }, { status: 'refused', code: 'trade.venue.venue_down' }).tickers,
    ).toEqual({
      status: 'refused',
      code: 'trade.venue.venue_down',
    });
  });
  it('keeps the own read where the venue door is off, and shows the venue read otherwise', () => {
    const tickers = { status: 'ready', asOf: 1, data: {} } as const;
    expect(pickSource({ status: 'refused', code: 'trade.user_venue_off' }, own, tickers, venuePrices)).toEqual({
      markets: own,
      tickers,
      perpetuals: { status: 'empty' },
      source: 'own',
    });
    expect(pickSource({ status: 'refused', code: 'trade.venue.venue_down' }, own, tickers, venuePrices).markets).toEqual({
      status: 'refused',
      code: 'trade.venue.venue_down',
    });
    expect(pickSource({ status: 'loading' }, own, tickers, venuePrices).markets.status).toBe('loading');
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

// A perpetual's row on the markets list is priced at the venue's mark, with its 24h move from the venue's price 24 hours
// ago; a spot market keeps its last print. TEST figures.
describe('venueTickerRow', () => {
  const row = {
    symbol: 'BTC-PERP',
    last: null,
    high: null,
    low: null,
    baseVolume: '12.5',
    quoteVolume: '780000',
    bid: null,
    ask: null,
    spread: null,
  };
  it('prices a perpetual at its mark and moves it from its open', () => {
    expect(
      venueTickerRow({ ...row, mark: '62620', index: '61628', open: '61000', change: '1620', changePct: '0.026557377049180327' }),
    ).toMatchObject({
      last: '62620',
      open24h: '61000',
      change24h: '1620',
      changePct24h: '0.026557377049180327',
      baseVolume24h: '12.5',
      quoteVolume24h: '780000',
    });
  });
  it('keeps a spot print and leaves an unpublished figure null', () => {
    expect(venueTickerRow({ ...row, symbol: 'PURR-USDC', last: '4.55' })).toMatchObject({
      last: '4.55',
      open24h: null,
      changePct24h: null,
    });
    expect(venueTickerRow(row)).toMatchObject({ last: null, change24h: null });
  });
});

// Home's "All N markets" and Markets' count are one number, and Buy and sell offers the venue's open spot markets
// where our own book lists none. TEST figures.
describe('one count and one list of what can be bought', () => {
  const ready = (rows: VenueMarketState[]) => ({
    status: 'ready' as const,
    asOf: Date.parse(OPENS),
    data: { venueId: 'v', asOf: OPENS, value: { venue: { id: 'v', displayName: 'TEST venue' }, markets: rows, test: true } },
  });
  const empty: Loadable<MarketRow[]> = { status: 'empty' };
  const venue = ready([
    market({ symbol: 'PURR-USDC', baseAsset: 'PURR' }),
    market({ symbol: 'GONE-USDC', baseAsset: 'GONE' }, { delisted: true, delistsAt: OPENS }),
    market({ symbol: 'SOON-USDC', baseAsset: 'SOON' }, { open: false }),
    market({ symbol: 'BTC-PERP', kind: 'perpetual', quoteAsset: 'USDC' }),
    market({ symbol: 'ETH-PERP', kind: 'perpetual', baseAsset: 'ETH', quoteAsset: 'USDC' }),
  ]);
  const catalogue = pickSource(venue, empty, { status: 'empty' }, { status: 'empty' });

  it('counts the open and announced spot markets and every perpetual, never a delisted one', () => {
    // PURR-USDC open, SOON-USDC upcoming (listed with its state), two perpetuals; GONE-USDC delisted is not counted.
    expect(listedCount(catalogue)).toBe(4);
  });

  it('offers only the venue spot markets that take an order now', () => {
    expect(venueSpotMarkets(catalogue).map((m) => m.symbol)).toEqual(['PURR-USDC']);
    // Where the venue door is off, our own book's markets stand and nothing is offered from the venue.
    const own = pickSource({ status: 'refused', code: 'trade.user_venue_off' }, empty, { status: 'empty' }, { status: 'empty' });
    expect(venueSpotMarkets(own)).toEqual([]);
  });
});
