/**
 * THE PERPS TRADE JOURNAL (record `@intafaced/contracts/trade-journal-procedures`, whose comment defines every
 * figure). Every closed perpetual trade on the person's own venue account, worked from the venue's own fills, order
 * history and candles at the moment of the read. Read only: nothing is prepared, sent or stored, and the ledger posts
 * nothing. A venue that is down or refuses is a refusal, never an empty journal.
 *
 * Crash points: none; nothing is written.
 */
import {
  abs,
  add,
  compare,
  div,
  formatAmount,
  isZero,
  max,
  min,
  mul,
  neg,
  parseAmount,
  proRata,
  SCALE,
  sub,
  sum,
  ZERO,
  type Amount,
} from '@intafaced/ledger-client/money';
import type { JournalTrade, TradeJournal } from '@intafaced/contracts/trade-journal-procedures';
import { TRADE_JOURNAL_MAX_DAYS, TRADE_JOURNAL_MAX_TRADES } from '@intafaced/contracts/trade-journal-procedures';
import {
  isTestVenue,
  VENUE_CANDLE_INTERVALS,
  VenueRefusalError,
  type UserVenue,
  type UserVenueAccount,
  type UserVenueFill,
  type UserVenueOrderRecord,
  type VenueCandle,
  type VenueCandleInterval,
} from '@intafaced/venue-contracts';

export type TradeJournalCode = 'trade.journal_unavailable' | 'trade.journal_request_invalid';

export class TradeJournalError extends Error {
  constructor(
    message: string,
    readonly code: TradeJournalCode,
  ) {
    super(message);
    this.name = 'TradeJournalError';
  }
}

/** One fill, or the part of a flipping fill, that belongs to one trade. */
export interface TripPart {
  readonly fillId: string;
  readonly venueClientOrderId: string | null;
  readonly side: 'buy' | 'sell';
  readonly price: Amount;
  readonly amount: Amount;
  readonly fee: Amount;
  readonly feeAsset: string;
  readonly filledAt: Date;
  /** True when it opened or added to the position; false when it reduced or closed it. */
  readonly opening: boolean;
}

/** One trade from flat to flat on one market. */
export interface RoundTrip {
  readonly symbol: string;
  readonly side: 'long' | 'short';
  readonly parts: readonly TripPart[];
  /** The first opening fill's venue id. */
  readonly tradeId: string;
  readonly openedAt: Date;
  readonly closedAt: Date;
  readonly feeAsset: string;
}

const signed = (side: 'buy' | 'sell', amount: Amount): Amount => (side === 'buy' ? amount : neg(amount));
const sign = (a: Amount): -1 | 0 | 1 => compare(a, ZERO);

/**
 * The closed trades in `fills` (one market's or many), oldest first. `startPosition` is each market's signed position
 * before the first fill: a trade already open then, and one still open after the last fill, is not closed here and is
 * left out. A fill that crosses zero closes one trade and opens the next; its fee is split by amount.
 */
export function roundTrips(fills: readonly UserVenueFill[], startPosition: ReadonlyMap<string, Amount>): RoundTrip[] {
  const ordered = [...fills].sort((a, b) => a.filledAt.getTime() - b.filledAt.getTime());
  const state = new Map<string, { position: Amount; parts: TripPart[] | null }>();
  const done: RoundTrip[] = [];
  for (const f of ordered) {
    const start = startPosition.get(f.symbol) ?? ZERO;
    let s = state.get(f.symbol);
    // A market already open at the start is followed but not recorded until it is flat.
    if (!s) state.set(f.symbol, (s = { position: start, parts: isZero(start) ? [] : null }));
    const fee = add(f.venueFee, f.builderFee);
    const part = (amount: Amount, partFee: Amount, opening: boolean): TripPart => ({
      fillId: f.fillId,
      venueClientOrderId: f.venueClientOrderId,
      side: f.side,
      price: f.price,
      amount,
      fee: partFee,
      feeAsset: f.feeAsset,
      filledAt: f.filledAt,
      opening,
    });
    const delta = signed(f.side, f.amount);
    if (isZero(s.position) || sign(delta) === sign(s.position)) {
      s.parts?.push(part(f.amount, fee, true));
      s.position = add(s.position, delta);
      continue;
    }
    const held = abs(s.position);
    const closing = min(held, f.amount);
    const rest = sub(f.amount, closing);
    const closeFee = isZero(rest) ? fee : (proRata(fee, [closing, rest])[0] ?? ZERO);
    const openFee = sub(fee, closeFee);
    s.parts?.push(part(closing, closeFee, false));
    const side = sign(s.position) > 0 ? 'long' : 'short';
    s.position = add(s.position, delta);
    if (isZero(s.position) || !isZero(rest)) {
      const [first] = s.parts ?? [];
      if (s.parts && first)
        done.push({
          symbol: f.symbol,
          side,
          parts: s.parts,
          tradeId: first.fillId,
          openedAt: first.filledAt,
          closedAt: f.filledAt,
          feeAsset: first.feeAsset,
        });
      s.parts = isZero(rest) ? [] : [part(rest, openFee, true)];
    }
  }
  return done;
}

/** The weighted average price of `parts`. */
function averagePrice(parts: readonly TripPart[]): Amount {
  const amount = sum(parts.map((p) => p.amount));
  return div(sum(parts.map((p) => mul(p.price, p.amount))), amount);
}

/** Round to `places` decimal places, half away from zero. */
export function roundTo(a: Amount, places: number): Amount {
  const step = SCALE / 10n ** BigInt(places);
  const q = abs(a) / step;
  const r = abs(a) % step;
  const out = (r * 2n >= step ? q + 1n : q) * step;
  return sign(a) < 0 ? neg(out) : out;
}

/**
 * The planned stop and target: the first stop-loss and take-profit trigger orders on the trade's market that close it,
 * attached to one of its opening orders, else the first placed while it was open.
 */
export function plannedLevels(trip: RoundTrip, orders: readonly UserVenueOrderRecord[]): { stop: Amount | null; target: Amount | null } {
  const closeSide = trip.side === 'long' ? 'sell' : 'buy';
  const openIds = new Set(trip.parts.flatMap((p) => (p.opening && p.venueClientOrderId ? [p.venueClientOrderId] : [])));
  const openedAt = trip.openedAt.getTime();
  const closedAt = trip.closedAt.getTime();
  const pick = (role: 'stop_loss' | 'take_profit'): Amount | null => {
    const mine = orders
      .filter((r) => r.order.symbol === trip.symbol && r.order.side === closeSide && r.order.trigger?.role === role)
      .sort((a, b) => a.placedAt.getTime() - b.placedAt.getTime());
    const attached = mine.find((r) => r.order.parentClientOrderId && openIds.has(r.order.parentClientOrderId));
    const during = mine.find((r) => r.placedAt.getTime() >= openedAt && r.placedAt.getTime() < closedAt);
    return (attached ?? during)?.order.trigger?.price ?? null;
  };
  return { stop: pick('stop_loss'), target: pick('take_profit') };
}

/** The candle intervals tried, finest first (6h is left out: not every venue publishes it). */
const LADDER: readonly VenueCandleInterval[] = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '12h', '1d', '1w'];
/** The most candles one read asks for (the wire's and the venues' own cap). */
export const JOURNAL_CANDLES_PER_READ = 720;

/** The finest interval whose candles from the bucket `openedAt` falls in up to `now` fit in one read. */
export function candleIntervalFor(openedAt: Date, now: Date): { interval: VenueCandleInterval; since: Date } {
  for (const interval of LADDER) {
    const step = VENUE_CANDLE_INTERVALS[interval] * 1000;
    const since = Math.floor(openedAt.getTime() / step) * step;
    if (Math.floor((now.getTime() - since) / step) + 1 <= JOURNAL_CANDLES_PER_READ) return { interval, since: new Date(since) };
  }
  throw new TradeJournalError('the trade opened too long ago to read its candles', 'trade.journal_request_invalid');
}

/** One closed trade, worked from its parts, its planned levels and the venue's candles from its open onward. */
export function journalTrade(
  trip: RoundTrip,
  levels: { stop: Amount | null; target: Amount | null },
  read: { readonly candles: readonly VenueCandle[]; readonly interval: VenueCandleInterval },
): JournalTrade {
  const { candles, interval } = read;
  const opens = trip.parts.filter((p) => p.opening);
  const closes = trip.parts.filter((p) => !p.opening);
  const feeAsset = trip.feeAsset;
  if (trip.parts.some((p) => p.feeAsset !== feeAsset))
    throw new TradeJournalError(`a ${trip.symbol} trade was charged fees in more than one asset`, 'trade.journal_unavailable');
  const long = trip.side === 'long';
  const dir = long ? SCALE : neg(SCALE);
  const entry = averagePrice(opens);
  const exit = averagePrice(closes);
  const size = sum(opens.map((p) => p.amount));
  const fees = sum(trip.parts.map((p) => p.fee));
  const gross = sum(trip.parts.map((p) => mul(p.price, p.side === 'sell' ? p.amount : neg(p.amount))));
  const net = sub(gross, fees);
  const { openedAt, closedAt } = trip;
  const step = VENUE_CANDLE_INTERVALS[interval] * 1000;

  // From the candle the entry falls in onward; the window is those that opened before the exit.
  const fromEntry = candles
    .filter((c) => c.openAt.getTime() + step > openedAt.getTime())
    .sort((a, b) => a.openAt.getTime() - b.openAt.getTime());
  const window = fromEntry.filter((c) => c.openAt.getTime() <= closedAt.getTime());
  const prices = trip.parts.map((p) => p.price);
  const low = [...window.map((c) => c.lowPrice), ...prices].reduce(min);
  const high = [...window.map((c) => c.highPrice), ...prices].reduce(max);
  const worst = long ? low : high;
  const best = long ? high : low;
  const against = (p: Amount) => max(ZERO, long ? sub(entry, p) : sub(p, entry));
  const inFavour = (p: Amount) => max(ZERO, long ? sub(p, entry) : sub(entry, p));

  const risk = levels.stop === null ? null : mul(abs(sub(entry, levels.stop)), size);
  const rMultiple = risk === null || isZero(risk) ? null : roundTo(div(net, risk), 4);

  let disciplined: JournalTrade['disciplined'] = { exit: 'no_plan', exitPrice: null, netPnl: null };
  if (levels.stop !== null || levels.target !== null) {
    disciplined = { exit: 'unresolved', exitPrice: null, netPnl: null };
    const { stop, target } = levels;
    for (const c of fromEntry) {
      const stopHit = stop !== null && (long ? compare(c.lowPrice, stop) <= 0 : compare(c.highPrice, stop) >= 0);
      const targetHit = target !== null && (long ? compare(c.highPrice, target) >= 0 : compare(c.lowPrice, target) <= 0);
      const level = stopHit ? stop : targetHit ? target : null;
      if (level === null) continue;
      const result = sub(mul(mul(sub(level, entry), size), dir), fees);
      disciplined = { exit: stopHit ? 'stop' : 'target', exitPrice: formatAmount(level), netPnl: formatAmount(result) };
      break;
    }
  }

  return {
    tradeId: trip.tradeId,
    symbol: trip.symbol,
    side: trip.side,
    openedAt: openedAt.toISOString(),
    closedAt: closedAt.toISOString(),
    entryPrice: formatAmount(entry),
    exitPrice: formatAmount(exit),
    size: formatAmount(size),
    fees: formatAmount(fees),
    feeAsset,
    grossPnl: formatAmount(gross),
    netPnl: formatAmount(net),
    plannedStop: levels.stop === null ? null : formatAmount(levels.stop),
    plannedTarget: levels.target === null ? null : formatAmount(levels.target),
    rMultiple: rMultiple === null ? null : formatAmount(rMultiple),
    maePrice: formatAmount(worst),
    mae: formatAmount(against(worst)),
    mfePrice: formatAmount(best),
    mfe: formatAmount(inFavour(best)),
    candleInterval: interval,
    disciplined,
    fillIds: [...new Set(trip.parts.map((p) => p.fillId))],
  };
}

/** The venue reads the journal needs. A `UserVenue` with order history and candles is one. */
export type JournalVenue = Pick<UserVenue, 'venue' | 'markets' | 'fills' | 'positions' | 'orderHistory' | 'candles'>;

export interface TradeJournalDeps {
  readonly venue: () => Promise<JournalVenue>;
  /** The account a read names, a sub-account only when listed under the owner (UserVenueDoor.readableAccount). */
  readonly account: (owner: string, subAccount: string | null) => Promise<UserVenueAccount>;
  readonly now: () => Date;
}

export interface TradeJournalInput {
  readonly owner: string;
  readonly subAccount?: string | null;
  readonly since: string;
  readonly limit: number;
}

const DAY_MS = 86_400_000;

/** The closed perpetual trades of one venue account since `input.since`, newest closed first. */
export async function readTradeJournal(deps: TradeJournalDeps, input: TradeJournalInput): Promise<TradeJournal> {
  const now = deps.now();
  const since = new Date(input.since);
  if (Number.isNaN(since.getTime()) || since.getTime() > now.getTime() || now.getTime() - since.getTime() > TRADE_JOURNAL_MAX_DAYS * DAY_MS)
    throw new TradeJournalError(`since must be a time within the last ${TRADE_JOURNAL_MAX_DAYS} days`, 'trade.journal_request_invalid');
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > TRADE_JOURNAL_MAX_TRADES)
    throw new TradeJournalError(`limit must be a whole number from 1 to ${TRADE_JOURNAL_MAX_TRADES}`, 'trade.journal_request_invalid');
  const venue = await deps.venue();
  const candlesOf = venue.candles?.bind(venue);
  const historyOf = venue.orderHistory?.bind(venue);
  if (!historyOf || !candlesOf)
    throw new TradeJournalError('this venue publishes no order history or no candles to journal from', 'trade.journal_unavailable');
  const account = await deps.account(input.owner, input.subAccount ?? null);

  const [markets, fills, positions, orders] = await Promise.all([
    venue.markets(null),
    venue.fills(account, since),
    venue.positions(account),
    historyOf(account),
  ]);
  const perps = new Set(markets.value.filter((m) => m.kind === 'perpetual').map((m) => m.symbol));
  const perpFills = fills.value.filter((f) => perps.has(f.symbol));
  // Each market's position before the first fill: today's, less what the fills since moved.
  const start = new Map<string, Amount>();
  for (const p of positions.value) if (perps.has(p.symbol)) start.set(p.symbol, p.side === 'long' ? p.size : neg(p.size));
  for (const f of perpFills) start.set(f.symbol, sub(start.get(f.symbol) ?? ZERO, signed(f.side, f.amount)));

  const trips = roundTrips(perpFills, start)
    .sort((a, b) => b.closedAt.getTime() - a.closedAt.getTime())
    .slice(0, input.limit);

  const candleReads = new Map<string, Promise<readonly VenueCandle[]>>();
  const trades = await Promise.all(
    trips.map(async (trip) => {
      const { interval, since: from } = candleIntervalFor(trip.openedAt, now);
      const key = `${trip.symbol}|${interval}|${from.getTime()}`;
      let read = candleReads.get(key);
      if (!read) {
        read = candlesOf(trip.symbol, interval, { limit: JOURNAL_CANDLES_PER_READ, since: from }).then((r) => r.value);
        candleReads.set(key, read);
      }
      return journalTrade(trip, plannedLevels(trip, orders.value), { candles: await read, interval });
    }),
  );

  const resolved = trades.flatMap((t) => (t.disciplined.netPnl === null ? [] : [{ actual: t.netPnl, disciplined: t.disciplined.netPnl }]));
  const total = (xs: readonly string[]) => formatAmount(sum(xs.map((x) => parseAmount(x))));
  return {
    venue: { id: venue.venue.id, name: venue.venue.displayName, test: isTestVenue(venue.venue) },
    owner: account.owner,
    subAccount: account.subAccount,
    since: since.toISOString(),
    asOf: fills.asOf.toISOString(),
    trades,
    totals: {
      count: trades.length,
      netPnl: total(trades.map((t) => t.netPnl)),
      disciplinedCount: resolved.length,
      actualNetPnlOfDisciplined: total(resolved.map((t) => t.actual)),
      disciplinedNetPnl: total(resolved.map((t) => t.disciplined)),
    },
  };
}

/** A venue refusal (down, unknown account) answers as the journal being unavailable, in the venue's words. */
export function journalRefusal(err: unknown): TradeJournalError | undefined {
  if (err instanceof TradeJournalError) return err;
  if (err instanceof VenueRefusalError) return new TradeJournalError(err.refusal.detail, 'trade.journal_unavailable');
  return undefined;
}
