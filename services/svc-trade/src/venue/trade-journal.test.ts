import { describe, expect, it } from 'vitest';
import { parseAmount as a, sub, type Amount } from '@intafaced/ledger-client/money';
import { tradeJournalSchema } from '@intafaced/contracts/trade-journal-procedures';
import { partial } from '@intafaced/service-kit/testing';
import {
  VenueRefusalError,
  type UserVenueDescriptor,
  type UserVenueFill,
  type UserVenueFundingPayment,
  type UserVenueMarket,
  type UserVenueOrder,
  type UserVenueOrderRecord,
  type UserVenuePosition,
  type VenueCandle,
} from '@intafaced/venue-contracts';
import {
  candlesCover,
  journalTrade,
  plannedLevels,
  readTradeJournal,
  roundTo,
  roundTrips,
  TradeJournalError,
  type JournalVenue,
} from './trade-journal.js';
import { InMemoryTradeJournalStore } from './trade-journal-store.js';

const at = (hhmmss: string) => new Date(`2026-11-20T${hhmmss}.000Z`);

function fill(
  over: Partial<UserVenueFill> & Pick<UserVenueFill, 'fillId' | 'symbol' | 'side' | 'price' | 'amount' | 'filledAt'>,
): UserVenueFill {
  return { venueClientOrderId: null, role: 'taker', venueFee: a('0'), builderFee: a('0'), feeAsset: 'USDC', realisedPnl: null, ...over };
}

function candle(hhmm: string, low: string, high: string): VenueCandle {
  return { openAt: at(`${hhmm}:00`), openPrice: a(low), highPrice: a(high), lowPrice: a(low), closePrice: a(high), baseVolume: a('1') };
}

function trigger(
  symbol: string,
  side: 'buy' | 'sell',
  role: 'stop_loss' | 'take_profit',
  price: string,
  placedAt: Date,
  parent: string | null,
): UserVenueOrderRecord {
  return {
    placedAt,
    order: partial<UserVenueOrder>({
      venueOrderId: `${role}-${price}`,
      venueClientOrderId: null,
      symbol,
      side,
      price: a(price),
      reduceOnly: true,
      trigger: { price: a(price), source: 'mark', role, state: 'waiting', triggeredAt: null, failure: null },
      parentClientOrderId: parent,
    }),
  };
}

function payment(symbol: string, side: 'long' | 'short', amount: string, periodAt: Date): UserVenueFundingPayment {
  return {
    paymentId: `fund-${symbol}-${periodAt.toISOString()}`,
    symbol,
    side,
    size: a('2'),
    markPrice: a('100'),
    rate: a('0'),
    amount: a(amount),
    asset: 'USDC',
    periodAt,
  };
}

/*
 * HAND-WORKED EXAMPLE 1, a long on BTC-PERP scaled into:
 *   10:00:30 buy 1 @ 100 (venue fee 0.05, builder fee 0.01), the entry order c-entry
 *   10:02:10 buy 1 @ 102 (venue fee 0.06)
 *   10:05:20 sell 2 @ 110 (venue fee 0.11), the venue's realised result 18
 *   funding: −0.5 booked at 10:04 on the long; one at 09:00 (before it opened) and one on ETH are not its own.
 * entry (100 + 102) / 2 = 101; exit 110; largest size 2; venue fees 0.22, builder fee 0.01;
 * net 18 − 0.22 − 0.01 − 0.5 = 17.27.
 * Opened with (attached to c-entry): stop 96, target 112. 1R = |101 − 96| × 2 = 10, so R = 17.27 / 10 = 1.727.
 * 1-minute candles 10:00 to 10:05 (each fill's minute holds its price): lowest 98 → MAE 3 a unit, 6 dollars, 2.97%;
 * highest 110.5 → MFE 9.5 a unit, 19 dollars, 9.41%. The 09:59 candle (90 to 120) is before the trade and not counted.
 * Disciplined: from entry, the 10:06 candle's high 113 reaches the target before any low reaches 96 (10:07, low 95):
 * (112 − 101) × 2 − 0.23 = 21.77.
 */
const btcFills = [
  fill({
    fillId: 'b1',
    venueClientOrderId: 'c-entry',
    symbol: 'BTC-PERP',
    side: 'buy',
    price: a('100'),
    amount: a('1'),
    venueFee: a('0.05'),
    builderFee: a('0.01'),
    filledAt: at('10:00:30'),
  }),
  fill({
    fillId: 'b2',
    venueClientOrderId: 'c-add',
    symbol: 'BTC-PERP',
    side: 'buy',
    price: a('102'),
    amount: a('1'),
    venueFee: a('0.06'),
    filledAt: at('10:02:10'),
  }),
  fill({
    fillId: 'b3',
    venueClientOrderId: 'c-exit',
    symbol: 'BTC-PERP',
    side: 'sell',
    price: a('110'),
    amount: a('2'),
    venueFee: a('0.11'),
    realisedPnl: a('18'),
    filledAt: at('10:05:20'),
  }),
];
const btcCandles = [
  candle('09:59', '90', '120'),
  candle('10:00', '98', '100.5'),
  candle('10:01', '99.5', '101'),
  candle('10:02', '101', '103'),
  candle('10:03', '102', '106'),
  candle('10:04', '105', '109'),
  candle('10:05', '108', '110.5'),
  candle('10:06', '109', '113'),
  candle('10:07', '95', '110'),
];
const btcOrders = [
  trigger('BTC-PERP', 'sell', 'stop_loss', '96', at('10:00:30'), 'c-entry'),
  trigger('BTC-PERP', 'sell', 'take_profit', '112', at('10:00:30'), 'c-entry'),
  // Moved later, while open: not the stop it opened with.
  trigger('BTC-PERP', 'sell', 'stop_loss', '100', at('10:03:00'), null),
];
const btcFunding = [
  payment('BTC-PERP', 'long', '-0.5', at('10:04:00')),
  payment('BTC-PERP', 'long', '-9', at('09:00:00')),
  payment('ETH-PERP', 'long', '-7', at('10:04:00')),
];

/*
 * HAND-WORKED EXAMPLE 2, a short on ETH-PERP opened by a flip:
 *   the account is long 1 before the read;
 *   10:06:00 sell 3 @ 50 (venue fee 0.3, realised 5 on the long): closes the long 1 (not journalled: it opened before the
 *            read) and opens short 2, the fee split by size 0.1 / 0.2;
 *   10:08:00 buy 2 @ 45 (venue fee 0.09, realised 10): closes the short;
 *   10:09:00 buy 1 @ 46: a new long, still open, not journalled.
 * entry 50; exit 45; size 2; fees 0.2 + 0.09 = 0.29; net 10 − 0.29 = 9.71. No stop or target: no R, no plan.
 * Candles 10:06 to 10:08: highest 51 → MAE 1 a unit, 2 dollars, 2%; lowest 44 → MFE 6, 12 dollars, 12%.
 */
const ethFills = [
  fill({
    fillId: 'e1',
    symbol: 'ETH-PERP',
    side: 'sell',
    price: a('50'),
    amount: a('3'),
    venueFee: a('0.3'),
    realisedPnl: a('5'),
    filledAt: at('10:06:00'),
  }),
  fill({
    fillId: 'e2',
    symbol: 'ETH-PERP',
    side: 'buy',
    price: a('45'),
    amount: a('2'),
    venueFee: a('0.09'),
    realisedPnl: a('10'),
    filledAt: at('10:08:00'),
  }),
  fill({ fillId: 'e3', symbol: 'ETH-PERP', side: 'buy', price: a('46'), amount: a('1'), venueFee: a('0.046'), filledAt: at('10:09:00') }),
];
const ethCandles = [candle('10:06', '49.5', '51'), candle('10:07', '44', '50'), candle('10:08', '44.5', '46'), candle('10:09', '45', '46')];

describe('trade journal: round trips from the venue fills', () => {
  it('example 1: an entry and an add close as one long trade, its largest size 2', () => {
    const trips = roundTrips(btcFills, new Map());
    expect(trips).toHaveLength(1);
    expect(trips[0]!.side).toBe('long');
    expect(trips[0]!.largest).toBe(a('2'));
    expect(trips[0]!.parts.map((p) => [p.fillId, p.opening])).toEqual([
      ['b1', true],
      ['b2', true],
      ['b3', false],
    ]);
  });

  it('example 2: a flip closes the open long and opens a short, its fee split by size; an open trade is left out', () => {
    const trips = roundTrips(ethFills, new Map<string, Amount>([['ETH-PERP', a('1')]]));
    expect(trips).toHaveLength(1);
    expect(trips[0]!.side).toBe('short');
    expect(trips[0]!.parts.map((p) => [p.fillId, p.amount, p.venueFee, p.opening, p.split, p.realisedPnl])).toEqual([
      ['e1', a('2'), a('0.2'), true, true, null],
      ['e2', a('2'), a('0.09'), false, false, a('10')],
    ]);
  });

  it('a long one fill turns short is two trades at the same time, the fill, its fees and the realised result split by size', () => {
    // 10:00:10 buy 1 @ 100 (venue fee 0.1); 10:01:10 sell 3 @ 105 (venue fee 0.3, builder fee 0.03, realised 5);
    // 10:02:10 buy 2 @ 103 (venue fee 0.2, realised 4).
    // Long: buy 1 and 1 of the sell (fee 0.1, builder 0.01, realised 5): net 5 − 0.2 − 0.01 = 4.79.
    // Short: 2 of the sell (fee 0.2, builder 0.02) and the buy: net 4 − 0.4 − 0.02 = 3.58.
    const fills = [
      fill({
        fillId: 'f1',
        symbol: 'SOL-PERP',
        side: 'buy',
        price: a('100'),
        amount: a('1'),
        venueFee: a('0.1'),
        filledAt: at('10:00:10'),
      }),
      fill({
        fillId: 'f2',
        symbol: 'SOL-PERP',
        side: 'sell',
        price: a('105'),
        amount: a('3'),
        venueFee: a('0.3'),
        builderFee: a('0.03'),
        realisedPnl: a('5'),
        filledAt: at('10:01:10'),
      }),
      fill({
        fillId: 'f3',
        symbol: 'SOL-PERP',
        side: 'buy',
        price: a('103'),
        amount: a('2'),
        venueFee: a('0.2'),
        realisedPnl: a('4'),
        filledAt: at('10:02:10'),
      }),
    ];
    const candles = [candle('10:00', '99', '101'), candle('10:01', '104', '106'), candle('10:02', '102', '104')];
    const [long, short] = roundTrips(fills, new Map()).map((trip) =>
      journalTrade(trip, { stop: null, target: null }, { candles, funding: [] }),
    );
    expect([long!.side, long!.closedAt, long!.netPnl, long!.size]).toEqual(['long', '2026-11-20T10:01:10.000Z', '4.79', '1']);
    expect([short!.side, short!.openedAt, short!.netPnl, short!.size, short!.entryPrice]).toEqual([
      'short',
      '2026-11-20T10:01:10.000Z',
      '3.58',
      '2',
      '105',
    ]);
    expect(long!.fills.at(-1)).toMatchObject({
      fillId: 'f2',
      amount: '1',
      venueFee: '0.1',
      builderFee: '0.01',
      split: true,
      opening: false,
    });
    expect(short!.fills[0]).toMatchObject({ fillId: 'f2', amount: '2', venueFee: '0.2', builderFee: '0.02', split: true, opening: true });
  });
});

describe('trade journal: every figure of a closed trade, against the hand-worked examples', () => {
  it('example 1: fills, entry, exit, size, fees, funding, net, the stop it opened with, R, MAE, MFE and the disciplined result', () => {
    const trip = roundTrips(btcFills, new Map())[0]!;
    const levels = plannedLevels(trip, btcOrders);
    // The stop moved to 100 at 10:03 is nearer the entry: a tightening, never a widening.
    expect(levels).toEqual({ stop: a('96'), target: a('112'), laterStops: [a('100')] });
    expect(journalTrade(trip, levels, { candles: btcCandles, funding: btcFunding })).toEqual({
      tradeId: 'b1',
      symbol: 'BTC-PERP',
      side: 'long',
      openedAt: '2026-11-20T10:00:30.000Z',
      closedAt: '2026-11-20T10:05:20.000Z',
      entryPrice: '101',
      exitPrice: '110',
      size: '2',
      fills: [
        {
          fillId: 'b1',
          filledAt: '2026-11-20T10:00:30.000Z',
          side: 'buy',
          price: '100',
          amount: '1',
          venueFee: '0.05',
          builderFee: '0.01',
          feeAsset: 'USDC',
          opening: true,
          split: false,
        },
        {
          fillId: 'b2',
          filledAt: '2026-11-20T10:02:10.000Z',
          side: 'buy',
          price: '102',
          amount: '1',
          venueFee: '0.06',
          builderFee: '0',
          feeAsset: 'USDC',
          opening: true,
          split: false,
        },
        {
          fillId: 'b3',
          filledAt: '2026-11-20T10:05:20.000Z',
          side: 'sell',
          price: '110',
          amount: '2',
          venueFee: '0.11',
          builderFee: '0',
          feeAsset: 'USDC',
          opening: false,
          split: false,
        },
      ],
      feeAsset: 'USDC',
      realisedPnl: '18',
      venueFees: '0.22',
      builderFees: '0.01',
      funding: '-0.5',
      fundingPayments: 1,
      netPnl: '17.27',
      plannedStop: '96',
      plannedTarget: '112',
      risk: '10',
      rMultiple: '1.727',
      rMissing: null,
      excursion: {
        interval: '1m',
        complete: true,
        mae: { price: '98', perUnit: '3', usd: '6', pct: '2.97' },
        mfe: { price: '110.5', perUnit: '9.5', usd: '19', pct: '9.41' },
      },
      disciplined: { exit: 'target', exitPrice: '112', netPnl: '21.77' },
      // 1R = |101 − 96| × 2 = 10; its stop was only tightened, so it kept its rules and counts what it made.
      rules: { verdict: 'kept', netPnl: '17.27', oneR: '10', widenedStop: null, dailyLoss: null },
      fillIds: ['b1', 'b2', 'b3'],
    });
  });

  it('example 2: a short opened with no stop reads no R; MAE is the high, MFE the low', () => {
    const trip = roundTrips(ethFills, new Map<string, Amount>([['ETH-PERP', a('1')]]))[0]!;
    const levels = plannedLevels(trip, [trigger('ETH-PERP', 'buy', 'stop_loss', '60', at('09:00:00'), null)]);
    expect(levels).toEqual({ stop: null, target: null, laterStops: [] });
    const t = journalTrade(trip, levels, { candles: ethCandles, funding: [] });
    expect([t.entryPrice, t.exitPrice, t.size, t.venueFees, t.realisedPnl, t.netPnl]).toEqual(['50', '45', '2', '0.29', '10', '9.71']);
    expect([t.risk, t.rMultiple, t.rMissing]).toEqual([null, null, 'no_stop_when_opened']);
    expect(t.excursion).toEqual({
      interval: '1m',
      complete: true,
      mae: { price: '51', perUnit: '1', usd: '2', pct: '2' },
      mfe: { price: '44', perUnit: '6', usd: '12', pct: '12' },
    });
    expect(t.disciplined).toEqual({ exit: 'no_plan', exitPrice: null, netPnl: null });
  });

  it('the stop it opened with: unattached, placed before the second fill; one placed after that is not', () => {
    const trip = roundTrips(btcFills, new Map())[0]!;
    expect(plannedLevels(trip, [trigger('BTC-PERP', 'sell', 'stop_loss', '97', at('10:01:00'), null)]).stop).toBe(a('97'));
    expect(plannedLevels(trip, [trigger('BTC-PERP', 'sell', 'stop_loss', '100', at('10:03:00'), null)]).stop).toBeNull();
  });

  it('candles missing are "incomplete": no MAE or MFE in place of a figure, never 0', () => {
    const trip = roundTrips(btcFills, new Map())[0]!;
    // The venue no longer holds the 10:00 minute; or its 10:05 candle does not hold the exit fill's price.
    const gone = btcCandles.filter((c) => c.openAt.getTime() >= at('10:01:00').getTime());
    const short = btcCandles.map((c) => (c.openAt.getTime() === at('10:05:00').getTime() ? candle('10:05', '108', '109') : c));
    for (const candles of [gone, short, []]) {
      expect(candlesCover(trip, candles)).toBe(false);
      expect(journalTrade(trip, { stop: a('96'), target: null }, { candles, funding: [] }).excursion).toEqual({
        interval: '1m',
        complete: false,
        mae: null,
        mfe: null,
      });
    }
  });

  it('a closing fill the venue reports no realised result for leaves the net and R named unknown, never 0', () => {
    const fills = btcFills.map((f) => (f.fillId === 'b3' ? { ...f, realisedPnl: null } : f));
    const t = journalTrade(roundTrips(fills, new Map())[0]!, { stop: a('96'), target: null }, { candles: btcCandles, funding: [] });
    expect([t.realisedPnl, t.netPnl, t.risk, t.rMultiple, t.rMissing]).toEqual([null, null, '10', null, 'no_result']);
  });

  it('a stop at the entry makes 1R zero: no R, named as such, never a division by zero', () => {
    const trip = roundTrips(btcFills, new Map())[0]!;
    const read = { candles: btcCandles, funding: [] };
    const { entryPrice } = journalTrade(trip, { stop: null, target: null }, read);
    const t = journalTrade(trip, { stop: a(entryPrice), target: null }, read);
    expect([t.risk, t.rMultiple, t.rMissing]).toEqual(['0', null, 'stop_at_entry']);
  });

  it('a short whose stop and target are both reached in one candle leaves at the stop; R is negative on a loss', () => {
    // Short 1 @ 50 at 10:00:10, stop 52, target 45; bought back @ 51 at 10:01:30 (no fees, realised −1).
    // net −1, 1R 2 → R −0.5. The 10:02 candle (44 to 53) reaches both: the stop, (50 − 52) × 1 = −2.
    const fills = [
      fill({
        fillId: 's1',
        venueClientOrderId: 'x',
        symbol: 'SOL-PERP',
        side: 'sell',
        price: a('50'),
        amount: a('1'),
        filledAt: at('10:00:10'),
      }),
      fill({
        fillId: 's2',
        symbol: 'SOL-PERP',
        side: 'buy',
        price: a('51'),
        amount: a('1'),
        realisedPnl: a('-1'),
        filledAt: at('10:01:30'),
      }),
    ];
    const trip = roundTrips(fills, new Map())[0]!;
    const t = journalTrade(
      trip,
      { stop: a('52'), target: a('45') },
      { candles: [candle('10:00', '49', '50.5'), candle('10:01', '50', '51.5'), candle('10:02', '44', '53')], funding: [] },
    );
    expect([t.netPnl, t.rMultiple, t.excursion.mae?.perUnit, t.excursion.mfe?.perUnit]).toEqual(['-1', '-0.5', '1.5', '1']);
    expect(t.disciplined).toEqual({ exit: 'stop', exitPrice: '52', netPnl: '-2' });
  });

  it('neither level reached yet is unresolved, never guessed', () => {
    const trip = roundTrips(btcFills, new Map())[0]!;
    expect(journalTrade(trip, { stop: a('90'), target: a('200') }, { candles: btcCandles, funding: [] }).disciplined).toEqual({
      exit: 'unresolved',
      exitPrice: null,
      netPnl: null,
    });
  });

  it('R rounds to four places, half away from zero', () => {
    expect(roundTo(a('1.23455'), 4)).toBe(a('1.2346'));
    expect(roundTo(a('-1.23455'), 4)).toBe(a('-1.2346'));
    expect(roundTo(a('2.00004'), 4)).toBe(a('2'));
  });
});

describe('trade journal: the read and its own record', () => {
  const account = { venueId: 'hl-test', owner: '0x1111111111111111111111111111111111111111', subAccount: null };
  function venue(over: Partial<JournalVenue> = {}): JournalVenue {
    const asOf = at('10:10:00');
    const venueId = 'hl-test';
    return partial<JournalVenue>({
      venue: partial<UserVenueDescriptor>({ id: 'hl-test', displayName: 'TEST venue', proofLevel: 'simulator' }),
      markets: async () => ({
        venueId,
        asOf,
        value: [
          partial<UserVenueMarket>({ symbol: 'BTC-PERP', kind: 'perpetual' }),
          partial<UserVenueMarket>({ symbol: 'ETH-PERP', kind: 'perpetual' }),
          partial<UserVenueMarket>({ symbol: 'BTC-USDC', kind: 'spot' }),
        ],
      }),
      fills: async () => ({
        venueId,
        asOf,
        value: [
          ...btcFills,
          ...ethFills,
          fill({ fillId: 'spot', symbol: 'BTC-USDC', side: 'sell', price: a('100'), amount: a('1'), filledAt: at('10:01:00') }),
        ],
      }),
      positions: async () => ({ venueId, asOf, value: [partial<UserVenuePosition>({ symbol: 'ETH-PERP', side: 'long', size: a('1') })] }),
      orderHistory: async () => ({ venueId, asOf, value: btcOrders }),
      fundingPayments: async () => ({ venueId, asOf, value: btcFunding }),
      candles: async (symbol: string) => ({ venueId, asOf, value: symbol === 'BTC-PERP' ? btcCandles : ethCandles }),
      ...over,
    });
  }
  let clock = at('10:10:00');
  const deps = (v: JournalVenue, store = new InMemoryTradeJournalStore()) => ({
    venue: async () => v,
    account: async () => account,
    ownWallets: async () => [account],
    store,
    now: () => clock,
  });
  const input = { owner: account.owner, since: '2026-11-20T09:00:00.000Z', limit: 50 };

  it('returns every closed perpetual trade, newest closed first, with the actual and disciplined totals', async () => {
    const j = tradeJournalSchema.parse(await readTradeJournal(deps(venue()), input, 'user-1'));
    expect(j.trades.map((t) => [t.symbol, t.netPnl, t.source, t.storedAt])).toEqual([
      ['ETH-PERP', '9.71', 'venue', '2026-11-20T10:10:00.000Z'],
      ['BTC-PERP', '17.27', 'venue', '2026-11-20T10:10:00.000Z'],
    ]);
    expect(j.totals).toEqual({
      count: 2,
      netPnl: '26.98',
      netUnknown: 0,
      disciplinedCount: 1,
      actualNetPnlOfDisciplined: '17.27',
      disciplinedNetPnl: '21.77',
      // No rule broken on either trade: the rules line is what they made.
      rulesNetPnl: '26.98',
    });
    expect(j.venue).toEqual({ id: 'hl-test', name: 'TEST venue', test: true });
  });

  it('a trade stays whole from the record after the venue stops returning its fills and candles, with the time it was stored', async () => {
    const store = new InMemoryTradeJournalStore();
    clock = at('10:10:00');
    const first = await readTradeJournal(deps(venue(), store), input, 'user-1');
    clock = at('10:20:00');
    const empty = { venueId: 'hl-test', asOf: at('10:20:00'), value: [] };
    const later = await readTradeJournal(
      deps(venue({ fills: async () => empty, candles: async () => empty, fundingPayments: async () => empty }), store),
      input,
      'user-1',
    );
    expect(later.trades.map((t) => t.source)).toEqual(['record', 'record']);
    expect(later.trades.map(({ source: _s, ...t }) => t)).toEqual(first.trades.map(({ source: _s, ...t }) => t));
    expect(later.trades[0]!.storedAt).toBe('2026-11-20T10:10:00.000Z');
    clock = at('10:10:00');
  });

  it('a trade first kept with its candles missing is completed once a later read has them; a complete one never changes', async () => {
    const store = new InMemoryTradeJournalStore();
    clock = at('10:10:00');
    const none = { venueId: 'hl-test', asOf: at('10:10:00'), value: [] };
    const first = await readTradeJournal(deps(venue({ candles: async () => none }), store), input, 'user-1');
    expect(first.trades.map((t) => t.excursion.complete)).toEqual([false, false]);
    clock = at('10:11:00');
    const second = await readTradeJournal(deps(venue(), store), input, 'user-1');
    expect(second.trades.map((t) => [t.excursion.complete, t.storedAt])).toEqual([
      [true, '2026-11-20T10:11:00.000Z'],
      [true, '2026-11-20T10:11:00.000Z'],
    ]);
    clock = at('10:12:00');
    const third = await readTradeJournal(deps(venue({ candles: async () => none }), store), input, 'user-1');
    expect(third.trades).toEqual(second.trades);
    clock = at('10:10:00');
  });

  it('limit keeps the newest closed trades', async () => {
    const j = await readTradeJournal(deps(venue()), { ...input, limit: 1 }, 'user-1');
    expect(j.trades.map((t) => t.symbol)).toEqual(['ETH-PERP']);
  });

  it('refuses a start outside the last 90 days or in the future', async () => {
    for (const since of ['2026-08-01T00:00:00.000Z', '2026-11-21T00:00:00.000Z'])
      await expect(readTradeJournal(deps(venue()), { ...input, since }, 'user-1')).rejects.toMatchObject({
        code: 'trade.journal_request_invalid',
      });
  });

  it('a venue with no candles or funding, or one that refuses, is unavailable, never an empty journal', async () => {
    await expect(readTradeJournal(deps(venue({ candles: undefined })), input, 'user-1')).rejects.toMatchObject({
      code: 'trade.journal_unavailable',
    });
    await expect(readTradeJournal(deps(venue({ fundingPayments: undefined })), input, 'user-1')).rejects.toMatchObject({
      code: 'trade.journal_unavailable',
    });
    const down = venue({
      fills: async () => {
        throw new VenueRefusalError({ venueId: 'hl-test', code: 'venue_unavailable', detail: 'the venue did not answer' } as never);
      },
    });
    await expect(readTradeJournal(deps(down), input, 'user-1')).rejects.toBeInstanceOf(VenueRefusalError);
    expect(TradeJournalError).toBeDefined();
  });

  it("refuses a wallet the caller's own wallet never signed for through the door, reading and keeping nothing (#11222)", async () => {
    const store = new InMemoryTradeJournalStore();
    const read: string[] = [];
    const watched = venue({
      fills: async () => {
        read.push('fills');
        return { venueId: 'hl-test', asOf: at('10:10:00'), value: btcFills };
      },
    });
    const asked: unknown[] = [];
    const theirs = {
      ...deps(watched, store),
      // The caller's own wallet signed for another account only; the named owner is someone else's wallet.
      ownWallets: async (userId: string, venueId: string) => {
        asked.push({ userId, venueId });
        return [{ owner: '0x2222222222222222222222222222222222222222', subAccount: null }];
      },
    };
    await expect(readTradeJournal(theirs, input, 'user-1')).rejects.toMatchObject({ code: 'trade.journal_wallet_not_own' });
    expect(asked).toEqual([{ userId: 'user-1', venueId: 'hl-test' }]);
    expect(read).toEqual([]);
    expect(store.rows.size).toBe(0);
  });

  it('reads and keeps the journal of a wallet whose owner signature the caller gave through the door', async () => {
    const store = new InMemoryTradeJournalStore();
    const own = {
      ...deps(venue(), store),
      ownWallets: async () => [{ owner: account.owner.toUpperCase().replace('0X', '0x'), subAccount: null }],
    };
    const j = await readTradeJournal(own, input, 'user-1');
    expect(j.trades.length).toBeGreaterThan(0);
    expect(store.rows.size).toBe(1);
  });
});

/*
 * HAND-WORKED "KEEPING MY RULES" EXAMPLES (J-portfolio-19), each a long on SOL-PERP of 1 @ 100, fees 0.1 on each of its
 * two fills (0.2 in all), opened with a stop at 95 attached to its entry order: 1R = |100 − 95| × 1 = 5, so minus 1R less
 * its fees is −5 − 0.2 = −5.2.
 *   widened, lost:  the stop moved to 90 at 10:01; the 10:02 candle's low 92 reaches 95; sold @ 92: net −8.2. Capped −5.2.
 *   widened, won:   the stop moved to 90; the 10:02 low 94 reaches 95; sold @ 108: net 7.8. Stopped −5.2, not 7.8.
 *   widened, never reached: the stop moved to 90; lows stay at 97; sold @ 104: net 3.8. Counts 3.8.
 *   warned at open: its entry order carries the daily loss limit's warning (limit 20, lost 25.5): left out, 0.
 *   no stop: net 3.8, counts 3.8.
 * And a short of 1 @ 100, stop 105 moved to 110, the 10:02 high 106 reaching 105, bought back @ 97: net 2.8. Stopped −5.2.
 */
describe('trade journal: the "keeping my rules" line (J-portfolio-19)', () => {
  const trip = (side: 'long' | 'short', exit: string) =>
    roundTrips(
      [
        fill({
          fillId: 'r1',
          venueClientOrderId: '0xentry',
          symbol: 'SOL-PERP',
          side: side === 'long' ? 'buy' : 'sell',
          price: a('100'),
          amount: a('1'),
          venueFee: a('0.1'),
          filledAt: at('10:00:10'),
        }),
        fill({
          fillId: 'r2',
          symbol: 'SOL-PERP',
          side: side === 'long' ? 'sell' : 'buy',
          price: a(exit),
          amount: a('1'),
          venueFee: a('0.1'),
          // The venue's realised result on the close: (exit − 100) × 1, the other way on a short.
          realisedPnl: side === 'long' ? sub(a(exit), a('100')) : sub(a('100'), a(exit)),
          filledAt: at('10:03:10'),
        }),
      ],
      new Map(),
    )[0]!;
  // The closing minute's candle is the close's own print, so the candles hold every fill.
  const candles = (low: string, high: string, exit: string) => [
    candle('10:00', '99', '101'),
    candle('10:01', '99', '101'),
    candle('10:02', low, high),
    candle('10:03', exit, exit),
  ];
  const stops = (side: 'long' | 'short', first: string, moved: string | null) => {
    const close = side === 'long' ? 'sell' : 'buy';
    return [
      trigger('SOL-PERP', close, 'stop_loss', first, at('10:00:10'), '0xentry'),
      ...(moved ? [trigger('SOL-PERP', close, 'stop_loss', moved, at('10:01:00'), null)] : []),
    ];
  };
  const rules = (side: 'long' | 'short', exit: string, c: VenueCandle[], orders: UserVenueOrderRecord[], warned = null as never) => {
    const t = trip(side, exit);
    return journalTrade(t, plannedLevels(t, orders), { candles: c, funding: [], warned }).rules;
  };

  it('a widened stop that lost more than 1R is capped at its first stop: minus 1R less its fees', () => {
    const r = rules('long', '92', candles('92', '100', '92'), stops('long', '95', '90'));
    expect(r).toEqual({ verdict: 'capped', netPnl: '-5.2', oneR: '5', widenedStop: '90', dailyLoss: null });
  });

  it('a widened stop that won after its price crossed the first stop counts as stopped there, not its profit', () => {
    expect(trip('long', '108').parts.length).toBe(2);
    expect(rules('long', '108', candles('94', '108', '108'), stops('long', '95', '90'))).toEqual({
      verdict: 'stopped',
      netPnl: '-5.2',
      oneR: '5',
      widenedStop: '90',
      dailyLoss: null,
    });
    expect(rules('short', '97', candles('97', '106', '97'), stops('short', '105', '110'))).toMatchObject({
      verdict: 'stopped',
      netPnl: '-5.2',
    });
  });

  it('a widened stop whose first stop was never reached, a trade with no stop, and one that kept its stop count what they made', () => {
    expect(rules('long', '104', candles('97', '104', '104'), stops('long', '95', '90'))).toMatchObject({
      verdict: 'widened_unreached',
      netPnl: '3.8',
    });
    expect(rules('long', '104', candles('92', '104', '104'), [])).toEqual({
      verdict: 'no_stop',
      netPnl: '3.8',
      oneR: null,
      widenedStop: null,
      dailyLoss: null,
    });
    // Reached its own stop's level but the stop was never moved: what it made stands.
    expect(rules('long', '94', candles('94', '100', '94'), stops('long', '95', null))).toMatchObject({ verdict: 'kept', netPnl: '-6.2' });
  });

  it('a widened stop with its candles missing, or a close with no realised result, is incomplete: null, never guessed', () => {
    // No candle for the closing minute: whether the first stop was reached cannot be read.
    const gap = [candle('10:00', '99', '101'), candle('10:01', '99', '101'), candle('10:02', '92', '100')];
    expect(rules('long', '92', gap, stops('long', '95', '90'))).toMatchObject({ verdict: 'incomplete', netPnl: null, widenedStop: '90' });
    const t = roundTrips(
      trip('long', '104').parts.map((p) => ({
        ...fill({ fillId: p.fillId, symbol: 'SOL-PERP', side: p.side, price: p.price, amount: p.amount, filledAt: p.filledAt }),
      })),
      new Map(),
    )[0]!;
    expect(journalTrade(t, plannedLevels(t, []), { candles: candles('97', '104', '104'), funding: [] }).rules).toMatchObject({
      verdict: 'incomplete',
      netPnl: null,
    });
  });

  it("a trade opened on an order warned by the daily loss limit counts 0, with the warning's figures", () => {
    const warned = { venueClientOrderId: '0xentry', asset: 'USDC', limit: a('20'), loss: a('25.5'), warnedAt: at('10:00:05') };
    expect(rules('long', '108', candles('94', '108', '108'), stops('long', '95', '90'), warned as never)).toEqual({
      verdict: 'left_out',
      netPnl: '0',
      oneR: '5',
      widenedStop: '90',
      dailyLoss: { limit: '20', loss: '25.5', asset: 'USDC', warnedAt: '2026-11-20T10:00:05.000Z' },
    });
  });

  it('the read matches a warning to the trade whose opening fill carries its order id, and totals the rules line', async () => {
    const account = { venueId: 'hl-test', owner: '0x1111111111111111111111111111111111111111', subAccount: null };
    const asOf = at('10:10:00');
    const venueId = 'hl-test';
    const v = partial<JournalVenue>({
      venue: partial<UserVenueDescriptor>({ id: venueId, displayName: 'TEST venue', proofLevel: 'simulator' }),
      markets: async () => ({ venueId, asOf, value: [partial<UserVenueMarket>({ symbol: 'BTC-PERP', kind: 'perpetual' })] }),
      fills: async () => ({ venueId, asOf, value: btcFills }),
      positions: async () => ({ venueId, asOf, value: [] }),
      orderHistory: async () => ({ venueId, asOf, value: btcOrders }),
      fundingPayments: async () => ({ venueId, asOf, value: btcFunding }),
      candles: async () => ({ venueId, asOf, value: btcCandles }),
    });
    const seen: unknown[] = [];
    const j = tradeJournalSchema.parse(
      await readTradeJournal(
        {
          venue: async () => v,
          account: async () => account,
          ownWallets: async () => [account],
          store: new InMemoryTradeJournalStore(),
          now: () => asOf,
          warned: async (key) => {
            seen.push(key);
            // The add (c-add) was warned: an opening order of the trade, so the whole trade is left out.
            return [{ venueClientOrderId: 'C-ADD', asset: 'USDC', limit: a('20'), loss: a('21'), warnedAt: at('10:02:00') }];
          },
        },
        { owner: account.owner, since: '2026-11-20T09:00:00.000Z', limit: 50 },
        'user-1',
      ),
    );
    expect(seen).toEqual([{ userId: 'user-1', venueId, owner: account.owner }]);
    expect(j.trades[0]!.rules).toMatchObject({ verdict: 'left_out', netPnl: '0' });
    expect(j.totals).toMatchObject({ netPnl: '17.27', rulesNetPnl: '0' });
  });
});
