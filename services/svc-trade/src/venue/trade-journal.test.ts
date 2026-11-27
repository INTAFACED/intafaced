import { describe, expect, it } from 'vitest';
import { parseAmount as a, type Amount } from '@intafaced/ledger-client/money';
import { tradeJournalSchema } from '@intafaced/contracts/trade-journal-procedures';
import { partial } from '@intafaced/service-kit/testing';
import {
  VenueRefusalError,
  type UserVenueDescriptor,
  type UserVenueFill,
  type UserVenueMarket,
  type UserVenueOrder,
  type UserVenueOrderRecord,
  type UserVenuePosition,
  type VenueCandle,
} from '@intafaced/venue-contracts';
import {
  candleIntervalFor,
  journalTrade,
  plannedLevels,
  readTradeJournal,
  roundTo,
  roundTrips,
  TradeJournalError,
  type JournalVenue,
} from './trade-journal.js';

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

/*
 * HAND-WORKED EXAMPLE 1, a long on BTC-PERP:
 *   10:00:30 buy 1 @ 100 (venue fee 0.05, builder fee 0.01), the entry order c-entry
 *   10:02:10 buy 1 @ 102 (fee 0.06)
 *   10:05:20 sell 2 @ 110 (fee 0.11)
 * entry (100 + 102) / 2 = 101; exit 110; size 2; fees 0.23; gross 220 − 202 = 18; net 17.77.
 * Planned at entry (attached to c-entry): stop 96, target 112. Risk |101 − 96| × 2 = 10, so R = 17.77 / 10 = 1.777.
 * Candles (1m) while open, 10:00 to 10:05: lowest 98 → MAE 101 − 98 = 3; highest 110.5 → MFE 9.5. The 09:59 candle
 * (low 90, high 120) ended before the entry and is not counted.
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
  // Moved later, while open: not the stop planned at entry.
  trigger('BTC-PERP', 'sell', 'stop_loss', '100', at('10:03:00'), null),
];

/*
 * HAND-WORKED EXAMPLE 2, a short on ETH-PERP opened by a flip:
 *   the account is long 1 before the read;
 *   10:06:00 sell 3 @ 50 (fee 0.3): closes the long 1 (not journalled: it opened before the read) and opens short 2,
 *            the fee split by amount 0.1 / 0.2;
 *   10:08:00 buy 2 @ 45 (fee 0.09): closes the short;
 *   10:09:00 buy 1 @ 46: a new long, still open, not journalled.
 * entry 50; exit 45; size 2; fees 0.2 + 0.09 = 0.29; gross 100 − 90 = 10; net 9.71. No stop or target: R null, no plan.
 * Candles 10:06 to 10:08: highest 51 → MAE 1 (against a short); lowest 44 → MFE 6.
 */
const ethFills = [
  fill({ fillId: 'e1', symbol: 'ETH-PERP', side: 'sell', price: a('50'), amount: a('3'), venueFee: a('0.3'), filledAt: at('10:06:00') }),
  fill({ fillId: 'e2', symbol: 'ETH-PERP', side: 'buy', price: a('45'), amount: a('2'), venueFee: a('0.09'), filledAt: at('10:08:00') }),
  fill({ fillId: 'e3', symbol: 'ETH-PERP', side: 'buy', price: a('46'), amount: a('1'), venueFee: a('0.046'), filledAt: at('10:09:00') }),
];
const ethCandles = [candle('10:06', '49.5', '51'), candle('10:07', '44', '50'), candle('10:08', '44.5', '46')];

describe('trade journal: round trips from the venue fills', () => {
  it('example 1: an entry and an add close as one long trade', () => {
    const trips = roundTrips(btcFills, new Map());
    expect(trips).toHaveLength(1);
    expect(trips[0]!.side).toBe('long');
    expect(trips[0]!.parts.map((p) => [p.fillId, p.opening])).toEqual([
      ['b1', true],
      ['b2', true],
      ['b3', false],
    ]);
  });

  it('example 2: a flip closes the open long and opens a short, its fee split by amount; an open trade is left out', () => {
    const trips = roundTrips(ethFills, new Map<string, Amount>([['ETH-PERP', a('1')]]));
    expect(trips).toHaveLength(1);
    expect(trips[0]!.side).toBe('short');
    expect(trips[0]!.parts.map((p) => [p.fillId, p.amount, p.fee, p.opening])).toEqual([
      ['e1', a('2'), a('0.2'), true],
      ['e2', a('2'), a('0.09'), false],
    ]);
  });
});

describe('trade journal: every figure of a closed trade, against the hand-worked examples', () => {
  it('example 1: entry, exit, size, fees, planned stop, R, MAE, MFE and the disciplined result', () => {
    const trip = roundTrips(btcFills, new Map())[0]!;
    const levels = plannedLevels(trip, btcOrders);
    // The stop moved to 100 at 10:03 is nearer the entry: a tightening, never a widening.
    expect(levels).toEqual({
      stop: a('96'),
      target: a('112'),
      laterStops: [a('100')],
      stopTimeline: [
        { price: a('96'), placedAt: at('10:00:30') },
        { price: a('100'), placedAt: at('10:03:00') },
      ],
    });
    expect(journalTrade(trip, levels, { candles: btcCandles, interval: '1m' })).toEqual({
      tradeId: 'b1',
      symbol: 'BTC-PERP',
      side: 'long',
      openedAt: '2026-11-20T10:00:30.000Z',
      closedAt: '2026-11-20T10:05:20.000Z',
      entryPrice: '101',
      exitPrice: '110',
      size: '2',
      fees: '0.23',
      feeAsset: 'USDC',
      grossPnl: '18',
      netPnl: '17.77',
      plannedStop: '96',
      plannedTarget: '112',
      rMultiple: '1.777',
      maePrice: '98',
      mae: '3',
      mfePrice: '110.5',
      mfe: '9.5',
      candleInterval: '1m',
      disciplined: { exit: 'target', exitPrice: '112', netPnl: '21.77' },
      // 1R = |101 − 96| × 2 = 10; its stop was only tightened, so it kept its rules and counts what it made.
      rules: { verdict: 'kept', netPnl: '17.77', oneR: '10', widenedStop: null, dailyLoss: null },
      fillIds: ['b1', 'b2', 'b3'],
    });
  });

  it('example 2: a short with no plan has no R and no disciplined result; MAE is the high, MFE the low', () => {
    const trip = roundTrips(ethFills, new Map<string, Amount>([['ETH-PERP', a('1')]]))[0]!;
    const levels = plannedLevels(trip, [trigger('ETH-PERP', 'buy', 'stop_loss', '60', at('09:00:00'), null)]);
    expect(levels).toEqual({ stop: null, target: null, laterStops: [], stopTimeline: [] });
    const t = journalTrade(trip, levels, { candles: ethCandles, interval: '1m' });
    expect([t.entryPrice, t.exitPrice, t.size, t.fees, t.grossPnl, t.netPnl]).toEqual(['50', '45', '2', '0.29', '10', '9.71']);
    expect([t.rMultiple, t.maePrice, t.mae, t.mfePrice, t.mfe]).toEqual([null, '51', '1', '44', '6']);
    expect(t.disciplined).toEqual({ exit: 'no_plan', exitPrice: null, netPnl: null });
  });

  it('a short whose stop and target are both reached in one candle leaves at the stop; R is negative on a loss', () => {
    // Short 1 @ 50 at 10:00:10, stop 52, target 45; bought back @ 51 at 10:01:30 (no fees).
    // net −1, risk 2 → R −0.5. The 10:02 candle (44 to 53) reaches both: the stop, (50 − 52) × 1 = −2.
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
      fill({ fillId: 's2', symbol: 'SOL-PERP', side: 'buy', price: a('51'), amount: a('1'), filledAt: at('10:01:30') }),
    ];
    const trip = roundTrips(fills, new Map())[0]!;
    const t = journalTrade(
      trip,
      { stop: a('52'), target: a('45') },
      { candles: [candle('10:00', '49', '50.5'), candle('10:01', '50', '51.5'), candle('10:02', '44', '53')], interval: '1m' },
    );
    expect([t.netPnl, t.rMultiple, t.mae, t.mfe]).toEqual(['-1', '-0.5', '1.5', '1']);
    expect(t.disciplined).toEqual({ exit: 'stop', exitPrice: '52', netPnl: '-2' });
  });

  it('neither level reached yet is unresolved, never guessed', () => {
    const trip = roundTrips(btcFills, new Map())[0]!;
    expect(journalTrade(trip, { stop: a('90'), target: a('200') }, { candles: btcCandles, interval: '1m' }).disciplined).toEqual({
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

  it('candles are read at the finest interval whose read covers the trade from its open to now', () => {
    expect(candleIntervalFor(at('10:00:30'), at('10:10:00'))).toEqual({ interval: '1m', since: at('10:00:00') });
    expect(candleIntervalFor(new Date('2026-11-19T10:00:30Z'), at('10:00:00'))).toEqual({
      interval: '3m',
      since: new Date('2026-11-19T10:00:00Z'),
    });
  });
});

describe('trade journal: the read', () => {
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
      candles: async (symbol: string) => ({ venueId, asOf, value: symbol === 'BTC-PERP' ? btcCandles : ethCandles }),
      ...over,
    });
  }
  const deps = (v: JournalVenue) => ({ venue: async () => v, account: async () => account, now: () => at('10:10:00') });
  const input = { owner: account.owner, since: '2026-11-20T09:00:00.000Z', limit: 50 };

  it('returns every closed perpetual trade, newest closed first, with the actual and disciplined totals', async () => {
    const j = tradeJournalSchema.parse(await readTradeJournal(deps(venue()), input));
    expect(j.trades.map((t) => [t.symbol, t.netPnl])).toEqual([
      ['ETH-PERP', '9.71'],
      ['BTC-PERP', '17.77'],
    ]);
    expect(j.totals).toEqual({
      count: 2,
      netPnl: '27.48',
      disciplinedCount: 1,
      actualNetPnlOfDisciplined: '17.77',
      disciplinedNetPnl: '21.77',
      // No rule broken on either trade: the rules line is what they made.
      rulesNetPnl: '27.48',
    });
    expect(j.venue).toEqual({ id: 'hl-test', name: 'TEST venue', test: true });
  });

  it('limit keeps the newest closed trades', async () => {
    const j = await readTradeJournal(deps(venue()), { ...input, limit: 1 });
    expect(j.trades.map((t) => t.symbol)).toEqual(['ETH-PERP']);
  });

  it('refuses a start outside the last 90 days or in the future', async () => {
    for (const since of ['2026-08-01T00:00:00.000Z', '2026-11-21T00:00:00.000Z'])
      await expect(readTradeJournal(deps(venue()), { ...input, since })).rejects.toMatchObject({ code: 'trade.journal_request_invalid' });
  });

  it('a venue with no candles, or one that refuses, is unavailable, never an empty journal', async () => {
    await expect(readTradeJournal(deps(venue({ candles: undefined })), input)).rejects.toMatchObject({ code: 'trade.journal_unavailable' });
    const down = venue({
      fills: async () => {
        throw new VenueRefusalError({ venueId: 'hl-test', code: 'venue_unavailable', detail: 'the venue did not answer' } as never);
      },
    });
    await expect(readTradeJournal(deps(down), input)).rejects.toBeInstanceOf(VenueRefusalError);
    expect(TradeJournalError).toBeDefined();
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
          filledAt: at('10:03:10'),
        }),
      ],
      new Map(),
    )[0]!;
  const candles = (low: string, high: string) => [candle('10:00', '99', '101'), candle('10:01', '99', '101'), candle('10:02', low, high)];
  const stops = (side: 'long' | 'short', first: string, moved: string | null) => {
    const close = side === 'long' ? 'sell' : 'buy';
    return [
      trigger('SOL-PERP', close, 'stop_loss', first, at('10:00:10'), '0xentry'),
      ...(moved ? [trigger('SOL-PERP', close, 'stop_loss', moved, at('10:01:00'), null)] : []),
    ];
  };
  const rules = (side: 'long' | 'short', exit: string, c: VenueCandle[], orders: UserVenueOrderRecord[], warned = null as never) => {
    const t = trip(side, exit);
    return journalTrade(t, plannedLevels(t, orders), { candles: c, interval: '1m', warned }).rules;
  };

  it('a widened stop that lost more than 1R is capped at its first stop: minus 1R less its fees', () => {
    const r = rules('long', '92', candles('92', '100'), stops('long', '95', '90'));
    expect(r).toEqual({ verdict: 'capped', netPnl: '-5.2', oneR: '5', widenedStop: '90', dailyLoss: null });
  });

  it('a widened stop that won after its price crossed the first stop counts as stopped there, not its profit', () => {
    expect(trip('long', '108').parts.length).toBe(2);
    expect(rules('long', '108', candles('94', '108'), stops('long', '95', '90'))).toEqual({
      verdict: 'stopped',
      netPnl: '-5.2',
      oneR: '5',
      widenedStop: '90',
      dailyLoss: null,
    });
    expect(rules('short', '97', candles('97', '106'), stops('short', '105', '110'))).toMatchObject({ verdict: 'stopped', netPnl: '-5.2' });
  });

  it('a widened stop whose first stop was never reached, a trade with no stop, and one that kept its stop count what they made', () => {
    expect(rules('long', '104', candles('97', '104'), stops('long', '95', '90'))).toMatchObject({
      verdict: 'widened_unreached',
      netPnl: '3.8',
    });
    expect(rules('long', '104', candles('92', '104'), [])).toEqual({
      verdict: 'no_stop',
      netPnl: '3.8',
      oneR: null,
      widenedStop: null,
      dailyLoss: null,
    });
    // Reached its own stop's level but the stop was never moved: what it made stands.
    expect(rules('long', '94', candles('94', '100'), stops('long', '95', null))).toMatchObject({ verdict: 'kept', netPnl: '-6.2' });
  });

  it("a trade opened on an order warned by the daily loss limit counts 0, with the warning's figures", () => {
    const warned = { venueClientOrderId: '0xentry', asset: 'USDC', limit: a('20'), loss: a('25.5'), warnedAt: at('10:00:05') };
    expect(rules('long', '108', candles('94', '108'), stops('long', '95', '90'), warned as never)).toEqual({
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
      candles: async () => ({ venueId, asOf, value: btcCandles }),
    });
    const seen: unknown[] = [];
    const j = tradeJournalSchema.parse(
      await readTradeJournal(
        {
          venue: async () => v,
          account: async () => account,
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
    expect(j.totals).toMatchObject({ netPnl: '17.77', rulesNetPnl: '0' });
  });
});
