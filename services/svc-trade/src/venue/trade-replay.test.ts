import { describe, expect, it } from 'vitest';
import { parseAmount as a } from '@intafaced/ledger-client/money';
import { tradeReplaySchema } from '@intafaced/contracts/trade-journal-procedures';
import { partial } from '@intafaced/service-kit/testing';
import type {
  UserVenueAccount,
  UserVenueDescriptor,
  UserVenueFill,
  UserVenueMarket,
  UserVenueOrder,
  UserVenueOrderRecord,
  VenueCandle,
} from '@intafaced/venue-contracts';
import { readTradeJournal, type JournalVenue } from './trade-journal.js';
import { readTradeReplay, replayCut, replayIntervalFor, TradeReplayError } from './trade-replay.js';

const at = (hhmmss: string) => new Date(`2026-11-20T${hhmmss}.000Z`);

function fill(over: Pick<UserVenueFill, 'fillId' | 'side' | 'price' | 'filledAt'> & Partial<UserVenueFill>): UserVenueFill {
  return {
    venueClientOrderId: null,
    symbol: 'XRBR-PERP',
    amount: a('1'),
    role: 'taker',
    venueFee: a('0.04'),
    builderFee: a('0'),
    feeAsset: 'USDC',
    realisedPnl: null,
    ...over,
  };
}

function stop(price: string, placedAt: Date): UserVenueOrderRecord {
  return {
    placedAt,
    order: partial<UserVenueOrder>({
      venueOrderId: `stop-${price}`,
      symbol: 'XRBR-PERP',
      side: 'sell',
      price: a(price),
      reduceOnly: true,
      trigger: { price: a(price), source: 'mark', role: 'stop_loss', state: 'waiting', triggeredAt: null, failure: null },
      parentClientOrderId: null,
    }),
  };
}

/** One 1m bar a minute from 09:50 to 10:09, each at 100 but the ones the trade's own fills printed. */
const bars: VenueCandle[] = Array.from({ length: 20 }, (_, i) => {
  const openAt = new Date(at('09:50:00').getTime() + i * 60_000);
  return { openAt, openPrice: a('100'), highPrice: a('101'), lowPrice: a('99'), closePrice: a('100'), baseVolume: a('1') };
});

/*
 * HAND-WORKED EXAMPLE: a long on XRBR-PERP. 10:02:10 buy 1 @ 100 (fee 0.04), its stop 95 placed at 10:02:20, moved to
 * 90 at 10:03:30, 10:04:40 sell 1 @ 102 (fee 0.04). The entry falls in the 10:02 bar, index 12 of the bars from 09:50;
 * the replay starts 10 bars before it, at 09:52, index 2. The trade's figures are the journal's: net 2 − 0.08 = 1.92.
 */
const fills = [
  fill({ fillId: 'x1', side: 'buy', price: a('100'), filledAt: at('10:02:10') }),
  fill({ fillId: 'x2', side: 'sell', price: a('102'), filledAt: at('10:04:40') }),
];
const orders = [stop('95', at('10:02:20')), stop('90', at('10:03:30'))];
const account: UserVenueAccount = { venueId: 'hl-test', owner: '0xabc', subAccount: null };

function venue(candles: readonly VenueCandle[] = bars): JournalVenue {
  const asOf = at('10:10:00');
  const venueId = 'hl-test';
  return partial<JournalVenue>({
    venue: partial<UserVenueDescriptor>({ id: 'hl-test', displayName: 'TEST venue', proofLevel: 'simulator' }),
    markets: async () => ({
      venueId,
      asOf,
      value: [partial<UserVenueMarket>({ symbol: 'XRBR-PERP', kind: 'perpetual', tickSize: a('0.01') })],
    }),
    fills: async () => ({ venueId, asOf, value: fills }),
    positions: async () => ({ venueId, asOf, value: [] }),
    orderHistory: async () => ({ venueId, asOf, value: orders }),
    candles: async (_symbol: string, _interval: string, query: number | { limit: number; since?: Date }) => {
      const since = typeof query === 'number' ? undefined : query.since;
      return { venueId, asOf, value: candles.filter((c) => !since || c.openAt.getTime() >= since.getTime()) };
    },
  });
}
const deps = (v: JournalVenue) => ({ venue: async () => v, account: async () => account, now: () => at('10:10:00') });
const input = { owner: '0xabc', since: '2026-11-20T09:00:00.000Z', tradeId: 'x1' };

describe('replayIntervalFor', () => {
  it('is the finest interval whose bars from 10 before the entry bar up to now fit in one read', () => {
    expect(replayIntervalFor(at('10:02:10'), at('10:10:00'))).toEqual({ interval: '1m', since: at('09:52:00') });
    // 715 minutes back: 10 more bars than 720 1m bars hold, so the next interval up.
    const opened = new Date(at('10:10:00').getTime() - 715 * 60_000);
    expect(replayIntervalFor(opened, at('10:10:00')).interval).toBe('3m');
  });
});

describe('replayCut', () => {
  it('starts 10 bars before the bar the entry falls in, or at the first bar when fewer were kept', () => {
    expect(replayCut(bars, at('10:02:10'), '1m')).toEqual({ entryIndex: 12, startIndex: 2 });
    expect(replayCut(bars, at('09:53:59'), '1m')).toEqual({ entryIndex: 3, startIndex: 0 });
  });
  it('is null when no bar holds the entry: the venue no longer returns its bars', () => {
    expect(replayCut(bars.slice(13), at('10:02:10'), '1m')).toBeNull();
    expect(replayCut([], at('10:02:10'), '1m')).toBeNull();
  });
});

describe('readTradeReplay', () => {
  it('answers the journal trade unchanged, its stops with the time each was placed, and the venue bars from 10 before the entry', async () => {
    const replay = tradeReplaySchema.parse(await readTradeReplay(deps(venue()), input));
    const journal = await readTradeJournal(deps(venue()), { ...input, limit: 100 });
    expect(replay.trade).toEqual(journal.trades.find((t) => t.tradeId === 'x1'));
    expect(replay.trade).toMatchObject({ entryPrice: '100', exitPrice: '102', netPnl: '1.92', plannedStop: '95' });
    expect(replay.stops).toEqual([
      { price: '95', placedAt: '2026-11-20T10:02:20.000Z' },
      { price: '90', placedAt: '2026-11-20T10:03:30.000Z' },
    ]);
    expect(replay.interval).toBe('1m');
    expect(replay.tickSize).toBe('0.01');
    if (replay.bars.source !== 'venue') throw new Error('expected venue bars');
    // The read starts at 09:52: 18 bars, the entry bar 10:02 at index 10, the replay's start at index 0.
    expect(replay.bars.candles).toHaveLength(18);
    expect(replay.bars.candles[0]!.openAt).toBe('2026-11-20T09:52:00.000Z');
    expect(replay.bars.entryIndex).toBe(10);
    expect(replay.bars.startIndex).toBe(0);
    expect(replay.venue).toEqual({ id: 'hl-test', name: 'TEST venue', test: true });
  });

  it('says the bars are not there when the venue no longer returns the entry bar, never a made-up chart', async () => {
    const replay = await readTradeReplay(deps(venue(bars.slice(14))), input);
    expect(replay.bars).toEqual({ source: 'none' });
    expect(replay.trade.tradeId).toBe('x1');
  });

  it('refuses a trade that is not in the journal', async () => {
    await expect(readTradeReplay(deps(venue()), { ...input, tradeId: 'nope' })).rejects.toBeInstanceOf(TradeReplayError);
    await expect(readTradeReplay(deps(venue()), { ...input, tradeId: 'nope' })).rejects.toMatchObject({
      code: 'trade.journal_trade_unknown',
    });
  });

  it('refuses a start outside the journal window as the journal does', async () => {
    await expect(readTradeReplay(deps(venue()), { ...input, since: '2026-08-01T00:00:00.000Z' })).rejects.toMatchObject({
      code: 'trade.journal_request_invalid',
    });
  });
});
