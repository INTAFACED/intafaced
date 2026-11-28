/**
 * THE REPLAY OF ONE JOURNAL TRADE (J-charts-desk-20; record `TRADE_JOURNAL_REPLAY` in
 * `@intafaced/contracts/trade-journal-procedures`, whose comment defines every field). The trade is the journal's own
 * (the same read, `workTradeJournal`), so the replay never shows a figure the journal does not. Its bars are the venue's
 * candles of the trade's market while the venue still returns the bar its entry falls in; after that, the bars the
 * journal kept with the trade, named with the time they were stored; and when none were kept, none. Read only: nothing
 * is sent to the venue, and the ledger posts nothing.
 *
 * Crash points: none of its own; the journal read it makes keeps the journal's record as `readTradeJournal` does.
 */
import { formatAmount } from '@intafaced/ledger-client/money';
import {
  REPLAY_BARS_BEFORE_ENTRY,
  TRADE_JOURNAL_MAX_TRADES,
  type ReplayBar,
  type TradeReplay,
} from '@intafaced/contracts/trade-journal-procedures';
import { VENUE_CANDLE_INTERVALS, type VenueCandleInterval } from '@intafaced/venue-contracts';
import { JOURNAL_CANDLES_PER_READ, TradeJournalError, workTradeJournal, type TradeJournalDeps } from './trade-journal.js';

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
 * Where a replay of a trade opened at `openedAt` starts in `bars` (oldest first): the bar the entry falls in, and
 * `REPLAY_BARS_BEFORE_ENTRY` bars before it (the first bar when fewer were kept). `null` when no bar holds the entry.
 */
export function replayCut(
  bars: readonly Pick<ReplayBar, 'openAt'>[],
  openedAt: Date,
  interval: VenueCandleInterval,
): { entryIndex: number; startIndex: number } | null {
  const step = VENUE_CANDLE_INTERVALS[interval] * 1000;
  const bucket = Math.floor(openedAt.getTime() / step) * step;
  const entryIndex = bars.findIndex((c) => Date.parse(c.openAt) === bucket);
  if (entryIndex < 0) return null;
  return { entryIndex, startIndex: Math.max(0, entryIndex - REPLAY_BARS_BEFORE_ENTRY) };
}

const isInterval = (x: string): x is VenueCandleInterval => Object.hasOwn(VENUE_CANDLE_INTERVALS, x);

export interface TradeReplayInput {
  readonly owner: string;
  readonly subAccount?: string | null;
  readonly since: string;
  readonly tradeId: string;
}

/** One closed trade of the journal, its stops over time and its market's bars. */
export async function readTradeReplay(deps: TradeJournalDeps, input: TradeReplayInput, userId?: string): Promise<TradeReplay> {
  const { journal, book } = await workTradeJournal(deps, { ...input, limit: TRADE_JOURNAL_MAX_TRADES }, userId);
  const trade = journal.trades.find((t) => t.tradeId === input.tradeId);
  if (!trade) throw new TradeReplayError(`there is no closed trade ${input.tradeId} in this journal`);
  const kept = await deps.store.replayOf(book, trade.tradeId);
  const openedAt = new Date(trade.openedAt);

  const venue = await deps.venue();
  const candlesOf = venue.candles?.bind(venue);
  const [markets, read] = await Promise.all([
    venue.markets(null),
    (async () => {
      if (!candlesOf) return null;
      const { interval, since } = replayIntervalFor(openedAt, deps.now());
      const r = await candlesOf(trade.symbol, interval, { limit: JOURNAL_CANDLES_PER_READ, since });
      const candles = [...r.value]
        .sort((a, b) => a.openAt.getTime() - b.openAt.getTime())
        .map((c) => ({
          openAt: c.openAt.toISOString(),
          openPrice: formatAmount(c.openPrice),
          highPrice: formatAmount(c.highPrice),
          lowPrice: formatAmount(c.lowPrice),
          closePrice: formatAmount(c.closePrice),
          baseVolume: formatAmount(c.baseVolume),
        }));
      return { interval, asOf: r.asOf, candles };
    })(),
  ]);
  const tickSize = markets.value.find((m) => m.symbol === trade.symbol)?.tickSize ?? null;
  const base = {
    venue: journal.venue,
    trade,
    tickSize: tickSize === null ? null : formatAmount(tickSize),
    stops: kept?.stops.map((s) => ({ price: s.price, placedAt: s.placedAt })) ?? [],
  };

  // The venue's own bars while it still returns the one the entry falls in.
  const onVenue = read ? replayCut(read.candles, openedAt, read.interval) : null;
  if (read && onVenue)
    return {
      ...base,
      interval: read.interval,
      bars: { source: 'venue', asOf: read.asOf.toISOString(), candles: read.candles, ...onVenue },
    };
  // Else the bars the journal kept with the trade, named with when it stored them.
  const keptCut = kept && isInterval(kept.interval) ? replayCut(kept.bars, openedAt, kept.interval) : null;
  if (kept && keptCut)
    return {
      ...base,
      interval: kept.interval,
      bars: { source: 'record', storedAt: kept.storedAt.toISOString(), candles: [...kept.bars], ...keptCut },
    };
  return { ...base, interval: read?.interval ?? kept?.interval ?? '1m', bars: { source: 'none' } };
}
