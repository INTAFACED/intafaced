/**
 * THE REPLAY OF ONE JOURNAL TRADE (J-charts-desk-20; record `TRADE_JOURNAL_REPLAY` in
 * `@intafaced/contracts/trade-journal-procedures`, whose comment defines every field). The trade is worked exactly as
 * the journal works it (the same reads, the same `journalTrade`), so the replay never shows a figure the journal does
 * not; its bars are the venue's own candles of the trade's market. Read only: nothing is sent, stored or posted.
 *
 * Crash points: none; nothing is written.
 */
import { formatAmount } from '@intafaced/ledger-client/money';
import { REPLAY_BARS_BEFORE_ENTRY, type TradeReplay } from '@intafaced/contracts/trade-journal-procedures';
import { isTestVenue, VENUE_CANDLE_INTERVALS, type VenueCandle, type VenueCandleInterval } from '@intafaced/venue-contracts';
import {
  candleIntervalFor,
  JOURNAL_CANDLES_PER_READ,
  journalReads,
  journalTrade,
  plannedLevels,
  TradeJournalError,
  warnedOn,
  type TradeJournalDeps,
} from './trade-journal.js';

export class TradeReplayError extends Error {
  readonly code = 'trade.journal_trade_unknown';
  constructor(message: string) {
    super(message);
    this.name = 'TradeReplayError';
  }
}

/** The candle intervals tried, finest first (6h is left out: not every venue publishes it). */
const LADDER: readonly VenueCandleInterval[] = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '12h', '1d', '1w'];

/**
 * The finest interval whose bars from `REPLAY_BARS_BEFORE_ENTRY` bars before the one `openedAt` falls in, up to `now`,
 * fit in one read, and the time that read starts from.
 */
export function replayIntervalFor(openedAt: Date, now: Date): { interval: VenueCandleInterval; since: Date } {
  for (const interval of LADDER) {
    const step = VENUE_CANDLE_INTERVALS[interval] * 1000;
    const since = Math.floor(openedAt.getTime() / step) * step - REPLAY_BARS_BEFORE_ENTRY * step;
    if (Math.floor((now.getTime() - since) / step) + 1 <= JOURNAL_CANDLES_PER_READ) return { interval, since: new Date(since) };
  }
  throw new TradeJournalError('the trade opened too long ago to read its bars', 'trade.journal_request_invalid');
}

/**
 * Where a replay of a trade opened at `openedAt` starts in `candles` (oldest first): the bar the entry falls in, and
 * `REPLAY_BARS_BEFORE_ENTRY` bars before it (the first bar when fewer were kept). `null` when no bar holds the entry:
 * the venue no longer returns the trade's bars.
 */
export function replayCut(
  candles: readonly VenueCandle[],
  openedAt: Date,
  interval: VenueCandleInterval,
): { entryIndex: number; startIndex: number } | null {
  const step = VENUE_CANDLE_INTERVALS[interval] * 1000;
  const bucket = Math.floor(openedAt.getTime() / step) * step;
  const entryIndex = candles.findIndex((c) => c.openAt.getTime() === bucket);
  if (entryIndex < 0) return null;
  return { entryIndex, startIndex: Math.max(0, entryIndex - REPLAY_BARS_BEFORE_ENTRY) };
}

export interface TradeReplayInput {
  readonly owner: string;
  readonly subAccount?: string | null;
  readonly since: string;
  readonly tradeId: string;
}

/** One closed trade of the journal, its stops over time and its market's bars from the venue. */
export async function readTradeReplay(deps: TradeJournalDeps, input: TradeReplayInput, userId?: string): Promise<TradeReplay> {
  const reads = await journalReads(deps, input, userId);
  const trip = reads.trips.find((t) => t.tradeId === input.tradeId);
  if (!trip) throw new TradeReplayError(`there is no closed trade ${input.tradeId} in this journal`);
  const levels = plannedLevels(trip, reads.orders);
  // The trade's figures, worked from the same candle read the journal makes, so they are the journal's own.
  const { interval: journalInterval, since: journalSince } = candleIntervalFor(trip.openedAt, reads.now);
  const journalCandles = await reads.candlesOf(trip.symbol, journalInterval, { limit: JOURNAL_CANDLES_PER_READ, since: journalSince });
  const trade = journalTrade(trip, levels, {
    candles: journalCandles.value,
    interval: journalInterval,
    warned: warnedOn(trip, reads.warnedBy),
  });

  const { interval, since } = replayIntervalFor(trip.openedAt, reads.now);
  const read = await reads.candlesOf(trip.symbol, interval, { limit: JOURNAL_CANDLES_PER_READ, since });
  const candles = [...read.value].sort((a, b) => a.openAt.getTime() - b.openAt.getTime());
  const cut = replayCut(candles, trip.openedAt, interval);
  return {
    venue: { id: reads.venue.venue.id, name: reads.venue.venue.displayName, test: isTestVenue(reads.venue.venue) },
    trade,
    stops: levels.stopTimeline.map((s) => ({ price: formatAmount(s.price), placedAt: s.placedAt.toISOString() })),
    interval,
    bars: cut
      ? {
          source: 'venue',
          asOf: read.asOf.toISOString(),
          candles: candles.map((c) => ({
            openAt: c.openAt.toISOString(),
            openPrice: formatAmount(c.openPrice),
            highPrice: formatAmount(c.highPrice),
            lowPrice: formatAmount(c.lowPrice),
            closePrice: formatAmount(c.closePrice),
            baseVolume: formatAmount(c.baseVolume),
          })),
          ...cut,
        }
      : { source: 'none' },
  };
}
