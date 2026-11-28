/**
 * THE PERPS TRADE JOURNAL (J-portfolio-18; record `@intafaced/contracts/trade-journal-procedures`, whose comment defines
 * every figure). Every closed perpetual trade on the person's own venue account, worked from the venue's own fills,
 * funding, order history and 1-minute candles, and kept in the journal's own record (trade-journal-store.ts). Nothing is
 * prepared or sent to the venue, and the ledger posts nothing. A venue that is down or refuses is a refusal, never an
 * empty journal.
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
import type { JournalTradeFigures, ReplayBar, TradeJournal } from '@intafaced/contracts/trade-journal-procedures';
import type { JournalBook, KeptReplay, TradeJournalStore } from './trade-journal-store.js';
import { REPLAY_BARS_BEFORE_ENTRY, TRADE_JOURNAL_MAX_DAYS, TRADE_JOURNAL_MAX_TRADES } from '@intafaced/contracts/trade-journal-procedures';
import {
  isTestVenue,
  VENUE_CANDLE_INTERVALS,
  VenueRefusalError,
  type UserVenue,
  type UserVenueAccount,
  type UserVenueFill,
  type UserVenueFundingPayment,
  type UserVenueOrderRecord,
  type VenueCandle,
  type VenueCandleInterval,
} from '@intafaced/venue-contracts';
import type { DailyLossWarnedOrder } from './daily-loss-limit-store.js';

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
  readonly venueFee: Amount;
  readonly builderFee: Amount;
  /** The venue's realised result on this part: a closing part carries its fill's; an opening part none (`null`). */
  readonly realisedPnl: Amount | null;
  readonly feeAsset: string;
  readonly filledAt: Date;
  /** True when it opened or added to the position; false when it reduced or closed it. */
  readonly opening: boolean;
  /** Part of a fill that flipped the position. */
  readonly split: boolean;
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
  /** The largest size held while open. */
  readonly largest: Amount;
}

const signed = (side: 'buy' | 'sell', amount: Amount): Amount => (side === 'buy' ? amount : neg(amount));
const sign = (a: Amount): -1 | 0 | 1 => compare(a, ZERO);

/**
 * The closed trades in `fills` (one market's or many), oldest first. `startPosition` is each market's signed position
 * before the first fill: a trade already open then, and one still open after the last fill, is not closed here and is
 * left out. A fill that crosses zero closes one trade and opens the next; its amount and fees split by size, and the
 * venue's realised result stays with the closing part.
 */
export function roundTrips(fills: readonly UserVenueFill[], startPosition: ReadonlyMap<string, Amount>): RoundTrip[] {
  const ordered = [...fills].sort((a, b) => a.filledAt.getTime() - b.filledAt.getTime());
  const state = new Map<string, { position: Amount; largest: Amount; parts: TripPart[] | null }>();
  const done: RoundTrip[] = [];
  for (const f of ordered) {
    const start = startPosition.get(f.symbol) ?? ZERO;
    let s = state.get(f.symbol);
    // A market already open at the start is followed but not recorded until it is flat.
    if (!s) state.set(f.symbol, (s = { position: start, largest: ZERO, parts: isZero(start) ? [] : null }));
    const part = (
      { amount, venueFee, builderFee }: { amount: Amount; venueFee: Amount; builderFee: Amount },
      { opening, split }: { opening: boolean; split: boolean },
    ): TripPart => ({
      fillId: f.fillId,
      venueClientOrderId: f.venueClientOrderId,
      side: f.side,
      price: f.price,
      amount,
      venueFee,
      builderFee,
      realisedPnl: opening ? null : f.realisedPnl,
      feeAsset: f.feeAsset,
      filledAt: f.filledAt,
      opening,
      split,
    });
    const delta = signed(f.side, f.amount);
    if (isZero(s.position) || sign(delta) === sign(s.position)) {
      s.parts?.push(part({ amount: f.amount, venueFee: f.venueFee, builderFee: f.builderFee }, { opening: true, split: false }));
      s.position = add(s.position, delta);
      s.largest = max(s.largest, abs(s.position));
      continue;
    }
    const held = abs(s.position);
    const closing = min(held, f.amount);
    const rest = sub(f.amount, closing);
    const flip = !isZero(rest);
    const share = (fee: Amount) => (flip ? (proRata(fee, [closing, rest])[0] ?? ZERO) : fee);
    const closeVenueFee = share(f.venueFee);
    const closeBuilderFee = share(f.builderFee);
    s.parts?.push(part({ amount: closing, venueFee: closeVenueFee, builderFee: closeBuilderFee }, { opening: false, split: flip }));
    const side = sign(s.position) > 0 ? 'long' : 'short';
    s.position = add(s.position, delta);
    if (isZero(s.position) || flip) {
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
          largest: s.largest,
        });
      s.parts = flip
        ? [
            part(
              { amount: rest, venueFee: sub(f.venueFee, closeVenueFee), builderFee: sub(f.builderFee, closeBuilderFee) },
              { opening: true, split: true },
            ),
          ]
        : [];
      s.largest = flip ? rest : ZERO;
    }
  }
  return done;
}

/** The size-weighted average price of `parts`. */
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
 * The stop and target the trade opened with: the first stop-loss and take-profit trigger orders on its market that close
 * it, attached to the order of its first fill, else placed before its second fill. `laterStops` are the stop-loss
 * trigger prices placed after that stop and before the close: where the person moved it (J-portfolio-19).
 */
export function plannedLevels(
  trip: RoundTrip,
  orders: readonly UserVenueOrderRecord[],
): { stop: Amount | null; target: Amount | null; laterStops: readonly Amount[] } {
  const timeline = stopTimeline(trip, orders);
  return {
    stop: timeline[0]?.price ?? null,
    target: firstLevel(trip, orders, 'take_profit')?.order.trigger?.price ?? null,
    laterStops: timeline.slice(1).map((s) => s.price),
  };
}

/**
 * Where the trade's stop stood: the stop it opened with (`plannedLevels`), then each stop-loss trigger placed after it
 * and before the close, with the time each was placed (J-charts-desk-20, the trade's replay).
 */
function stopTimeline(trip: RoundTrip, orders: readonly UserVenueOrderRecord[]): { price: Amount; placedAt: Date }[] {
  const first = firstLevel(trip, orders, 'stop_loss');
  if (!first) return [];
  const closedAt = trip.closedAt.getTime();
  return levelOrders(trip, orders, 'stop_loss')
    .filter((r) => r === first || (r.placedAt.getTime() > first.placedAt.getTime() && r.placedAt.getTime() < closedAt))
    .flatMap((r) => (r.order.trigger ? [{ price: r.order.trigger.price, placedAt: r.placedAt }] : []));
}

/** The trade's trigger orders of one role on its market that close it, oldest placed first. */
function levelOrders(trip: RoundTrip, orders: readonly UserVenueOrderRecord[], role: 'stop_loss' | 'take_profit') {
  const closeSide = trip.side === 'long' ? 'sell' : 'buy';
  return orders
    .filter((r) => r.order.symbol === trip.symbol && r.order.side === closeSide && r.order.trigger?.role === role)
    .sort((a, b) => a.placedAt.getTime() - b.placedAt.getTime());
}

/** The one the trade opened with: attached to the order of its first fill, else placed before its second fill. */
function firstLevel(
  trip: RoundTrip,
  orders: readonly UserVenueOrderRecord[],
  role: 'stop_loss' | 'take_profit',
): UserVenueOrderRecord | null {
  const [firstPart, secondPart] = trip.parts;
  const entryOrder = firstPart?.venueClientOrderId ?? null;
  const openedAt = trip.openedAt.getTime();
  const before = secondPart ? secondPart.filledAt.getTime() : trip.closedAt.getTime();
  const list = levelOrders(trip, orders, role);
  const attached = entryOrder ? list.find((r) => r.order.parentClientOrderId === entryOrder) : undefined;
  const atOpen = list.find((r) => r.placedAt.getTime() >= openedAt && r.placedAt.getTime() < before);
  return attached ?? atOpen ?? null;
}

/** What the "keeping my rules" line knows of a trade beyond its own figures, read with its candles: the warning on its opening order. */
export interface RulesContext {
  /** The warning given on one of its opening orders while the daily loss limit stood reached; null when none. */
  readonly warned: DailyLossWarnedOrder | null;
}

/**
 * The trade on the "keeping my rules" line (record `@intafaced/contracts/trade-journal-procedures` defines each verdict):
 * only a broken rule changes it. Opened past the daily loss limit: 0. Its stop widened past the first and the price
 * reaching that first stop: minus 1R less its fees. Anything else: what it made.
 */
function keepingRules(args: {
  readonly long: boolean;
  readonly entry: Amount;
  readonly size: Amount;
  readonly fees: Amount;
  /** Null when the venue reported no realised result on a closing fill. */
  readonly net: Amount | null;
  /** The worst price reached while open (MAE's price); null when the candles are incomplete. */
  readonly worst: Amount | null;
  readonly stop: Amount | null;
  readonly laterStops: readonly Amount[];
  readonly warned: DailyLossWarnedOrder | null;
}): JournalTradeFigures['rules'] {
  const { long, entry, size, fees, net, worst, stop, laterStops, warned } = args;
  const oneR = stop === null ? null : mul(abs(sub(entry, stop)), size);
  // Further from the entry than the first stop: lower on a long, higher on a short.
  const wider = stop === null ? [] : laterStops.filter((p) => (long ? compare(p, stop) < 0 : compare(p, stop) > 0));
  const widenedStop = wider.length === 0 ? null : wider.reduce(long ? min : max);
  const out = (verdict: JournalTradeFigures['rules']['verdict'], value: Amount | null): JournalTradeFigures['rules'] => ({
    verdict,
    netPnl: value === null ? null : formatAmount(value),
    oneR: oneR === null ? null : formatAmount(oneR),
    widenedStop: widenedStop === null ? null : formatAmount(widenedStop),
    dailyLoss: warned
      ? {
          limit: formatAmount(warned.limit),
          loss: formatAmount(warned.loss),
          asset: warned.asset,
          warnedAt: warned.warnedAt.toISOString(),
        }
      : null,
  });
  if (warned) return out('left_out', ZERO);
  // Without the venue's realised result, or with a widened stop and the candles that would show whether its first stop
  // was reached missing, what the trade counts cannot be worked out: named, never guessed.
  if (net === null) return out('incomplete', null);
  if (stop === null || oneR === null) return out('no_stop', net);
  if (widenedStop === null) return out('kept', net);
  if (worst === null) return out('incomplete', null);
  const reached = long ? compare(worst, stop) <= 0 : compare(worst, stop) >= 0;
  if (!reached) return out('widened_unreached', net);
  const atFirstStop = sub(neg(oneR), fees);
  return out(compare(atFirstStop, net) >= 0 ? 'capped' : 'stopped', atFirstStop);
}

/** The candle interval MAE, MFE and the disciplined exit are read at (J-portfolio-18 #3: the venue's 1-minute candles). */
const JOURNAL_CANDLE_INTERVAL = '1m' satisfies VenueCandleInterval;
/** The most candles one read asks for (the wire's and the venues' own cap): twelve hours of 1-minute candles. */
export const JOURNAL_CANDLES_PER_READ = 720;
const MINUTE_MS = VENUE_CANDLE_INTERVALS[JOURNAL_CANDLE_INTERVAL] * 1000;
const bucketOf = (t: Date) => Math.floor(t.getTime() / MINUTE_MS) * MINUTE_MS;

/**
 * Whether the candles hold the whole trade: every fill is a print, so each fill's minute has a candle whose range holds
 * the fill's price. A venue past the history it keeps (or a trade longer than one read) leaves one missing.
 */
export function candlesCover(trip: RoundTrip, candles: readonly VenueCandle[]): boolean {
  const byMinute = new Map(candles.map((c) => [c.openAt.getTime(), c]));
  return trip.parts.every((p) => {
    const c = byMinute.get(bucketOf(p.filledAt));
    return c !== undefined && compare(c.lowPrice, p.price) <= 0 && compare(c.highPrice, p.price) >= 0;
  });
}

/** One closed trade's figures, worked from its parts, the funding booked on it, its planned levels and its candles. */
export function journalTrade(
  trip: RoundTrip,
  levels: { stop: Amount | null; target: Amount | null; laterStops?: readonly Amount[] },
  read: { readonly candles: readonly VenueCandle[]; readonly funding: readonly UserVenueFundingPayment[] } & Partial<RulesContext>,
): JournalTradeFigures {
  const { candles, funding } = read;
  const opens = trip.parts.filter((p) => p.opening);
  const closes = trip.parts.filter((p) => !p.opening);
  const feeAsset = trip.feeAsset;
  if (trip.parts.some((p) => p.feeAsset !== feeAsset))
    throw new TradeJournalError(`a ${trip.symbol} trade was charged fees in more than one asset`, 'trade.journal_unavailable');
  const long = trip.side === 'long';
  const dir = long ? SCALE : neg(SCALE);
  const entry = averagePrice(opens);
  const exit = averagePrice(closes);
  const size = trip.largest;
  const opened = sum(opens.map((p) => p.amount));
  const venueFees = sum(trip.parts.map((p) => p.venueFee));
  const builderFees = sum(trip.parts.map((p) => p.builderFee));
  const fees = add(venueFees, builderFees);
  const { openedAt, closedAt } = trip;
  // The funding the venue booked on this position while it was open: periods closed after it opened, up to its close.
  const paid = funding.filter(
    (f) =>
      f.symbol === trip.symbol &&
      f.side === trip.side &&
      f.periodAt.getTime() > openedAt.getTime() &&
      f.periodAt.getTime() <= closedAt.getTime(),
  );
  const fundingTotal = sum(paid.map((f) => f.amount));
  const realised = closes.some((p) => p.realisedPnl === null) ? null : sum(closes.map((p) => p.realisedPnl ?? ZERO));
  const net = realised === null ? null : add(sub(realised, fees), fundingTotal);

  // The 1-minute candles over the trade's time: from the minute it opened to the minute it closed.
  const fromEntry = candles.filter((c) => c.openAt.getTime() >= bucketOf(openedAt)).sort((a, b) => a.openAt.getTime() - b.openAt.getTime());
  const window = fromEntry.filter((c) => c.openAt.getTime() <= closedAt.getTime());
  const complete = candlesCover(trip, candles);
  const excursion = (price: Amount, perUnit: Amount) => ({
    price: formatAmount(price),
    perUnit: formatAmount(perUnit),
    usd: formatAmount(mul(perUnit, size)),
    pct: formatAmount(roundTo(div(mul(perUnit, parseAmount('100')), entry), 2)),
  });
  let mae: JournalTradeFigures['excursion']['mae'] = null;
  let mfe: JournalTradeFigures['excursion']['mfe'] = null;
  if (complete) {
    const low = window.map((c) => c.lowPrice).reduce(min);
    const high = window.map((c) => c.highPrice).reduce(max);
    const worst = long ? low : high;
    const best = long ? high : low;
    mae = excursion(worst, max(ZERO, long ? sub(entry, worst) : sub(worst, entry)));
    mfe = excursion(best, max(ZERO, long ? sub(best, entry) : sub(entry, best)));
  }

  const risk = levels.stop === null ? null : mul(abs(sub(entry, levels.stop)), size);
  const rMultiple = risk === null || isZero(risk) || net === null ? null : roundTo(div(net, risk), 4);
  const rMissing =
    levels.stop === null
      ? 'no_stop_when_opened'
      : risk !== null && isZero(risk)
        ? 'stop_at_entry'
        : rMultiple === null
          ? 'no_result'
          : null;

  let disciplined: JournalTradeFigures['disciplined'] = { exit: 'no_plan', exitPrice: null, netPnl: null };
  if (levels.stop !== null || levels.target !== null) {
    disciplined = { exit: 'unresolved', exitPrice: null, netPnl: null };
    const { stop, target } = levels;
    for (const c of fromEntry) {
      const stopHit = stop !== null && (long ? compare(c.lowPrice, stop) <= 0 : compare(c.highPrice, stop) >= 0);
      const targetHit = target !== null && (long ? compare(c.highPrice, target) >= 0 : compare(c.lowPrice, target) <= 0);
      const level = stopHit ? stop : targetHit ? target : null;
      if (level === null) continue;
      const result = sub(mul(mul(sub(level, entry), opened), dir), fees);
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
    fills: trip.parts.map((p) => ({
      fillId: p.fillId,
      filledAt: p.filledAt.toISOString(),
      side: p.side,
      price: formatAmount(p.price),
      amount: formatAmount(p.amount),
      venueFee: formatAmount(p.venueFee),
      builderFee: formatAmount(p.builderFee),
      feeAsset: p.feeAsset,
      opening: p.opening,
      split: p.split,
    })),
    feeAsset,
    realisedPnl: realised === null ? null : formatAmount(realised),
    venueFees: formatAmount(venueFees),
    builderFees: formatAmount(builderFees),
    funding: formatAmount(fundingTotal),
    fundingPayments: paid.length,
    netPnl: net === null ? null : formatAmount(net),
    plannedStop: levels.stop === null ? null : formatAmount(levels.stop),
    plannedTarget: levels.target === null ? null : formatAmount(levels.target),
    risk: risk === null ? null : formatAmount(risk),
    rMultiple: rMultiple === null ? null : formatAmount(rMultiple),
    rMissing,
    excursion: { interval: JOURNAL_CANDLE_INTERVAL, complete, mae, mfe },
    disciplined,
    rules: keepingRules({
      long,
      entry,
      size,
      fees,
      net,
      worst: mae === null ? null : parseAmount(mae.price),
      stop: levels.stop,
      laterStops: levels.laterStops ?? [],
      warned: read.warned ?? null,
    }),
    fillIds: [...new Set(trip.parts.map((p) => p.fillId))],
  };
}

/** The venue reads the journal needs. A `UserVenue` with order history, funding and candles is one. */
export type JournalVenue = Pick<UserVenue, 'venue' | 'markets' | 'fills' | 'positions' | 'orderHistory' | 'candles' | 'fundingPayments'>;

export interface TradeJournalDeps {
  readonly venue: () => Promise<JournalVenue>;
  /** The account a read names, a sub-account only when listed under the owner (UserVenueDoor.readableAccount). */
  readonly account: (owner: string, subAccount: string | null) => Promise<UserVenueAccount>;
  /** The journal's own record of the closed trades (trade-journal-store.ts). */
  readonly store: TradeJournalStore;
  readonly now: () => Date;
  /**
   * The opening orders the person was warned on while their daily loss limit stood reached (daily-loss-limit-store.ts),
   * for the "keeping my rules" line. Absent: no warning is known, and none is guessed.
   */
  readonly warned?: (key: { userId: string; venueId: string; owner: string }) => Promise<readonly DailyLossWarnedOrder[]>;
}

export interface TradeJournalInput {
  readonly owner: string;
  readonly subAccount?: string | null;
  readonly since: string;
  readonly limit: number;
}

const DAY_MS = 86_400_000;

/**
 * The closed perpetual trades of one venue account since `input.since`, newest closed first: every one the venue's fills
 * show now is worked and kept in the journal's record (once; a trade kept with its candles missing is completed when a
 * later read has them), and the read answers from that record, so a trade the venue no longer returns stays whole.
 *
 * Crash points: between the venue read and the store, nothing is kept and the next read works it again; a trade is keyed
 * by its venue, account and first fill, so a second read never stores it twice.
 */
export async function readTradeJournal(deps: TradeJournalDeps, input: TradeJournalInput, userId?: string): Promise<TradeJournal> {
  return (await workTradeJournal(deps, input, userId)).journal;
}

/** The bars a trade's replay keeps: its market's 1-minute candles from 10 bars before its entry bar to its close. */
function replayBarsOf(trip: Pick<RoundTrip, 'openedAt' | 'closedAt'>, candles: readonly VenueCandle[]): ReplayBar[] {
  const from = bucketOf(trip.openedAt) - REPLAY_BARS_BEFORE_ENTRY * MINUTE_MS;
  return candles
    .filter((c) => c.openAt.getTime() >= from && c.openAt.getTime() <= trip.closedAt.getTime())
    .sort((a, b) => a.openAt.getTime() - b.openAt.getTime())
    .map((c) => ({
      openAt: c.openAt.toISOString(),
      openPrice: formatAmount(c.openPrice),
      highPrice: formatAmount(c.highPrice),
      lowPrice: formatAmount(c.lowPrice),
      closePrice: formatAmount(c.closePrice),
      baseVolume: formatAmount(c.baseVolume),
    }));
}

/**
 * `readTradeJournal`, and the account's book in the journal's record, for the trade replay (trade-replay.ts). Beside each
 * trade it keeps that trade's replay (`replayBarsOf` and its stop timeline), so a trade the venue no longer returns
 * still replays. Crash points: as `readTradeJournal`'s; a trade kept without its replay gets it on the next read.
 */
export async function workTradeJournal(
  deps: TradeJournalDeps,
  input: TradeJournalInput,
  userId?: string,
): Promise<{ journal: TradeJournal; book: JournalBook }> {
  const now = deps.now();
  const since = new Date(input.since);
  if (Number.isNaN(since.getTime()) || since.getTime() > now.getTime() || now.getTime() - since.getTime() > TRADE_JOURNAL_MAX_DAYS * DAY_MS)
    throw new TradeJournalError(`since must be a time within the last ${TRADE_JOURNAL_MAX_DAYS} days`, 'trade.journal_request_invalid');
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > TRADE_JOURNAL_MAX_TRADES)
    throw new TradeJournalError(`limit must be a whole number from 1 to ${TRADE_JOURNAL_MAX_TRADES}`, 'trade.journal_request_invalid');
  const venue = await deps.venue();
  const candlesOf = venue.candles?.bind(venue);
  const historyOf = venue.orderHistory?.bind(venue);
  const fundingOf = venue.fundingPayments?.bind(venue);
  if (!historyOf || !candlesOf || !fundingOf)
    throw new TradeJournalError('this venue publishes no order history, funding or candles to journal from', 'trade.journal_unavailable');
  const account = await deps.account(input.owner, input.subAccount ?? null);

  const [markets, fills, positions, orders, funding, warnings] = await Promise.all([
    venue.markets(null),
    venue.fills(account, since),
    venue.positions(account),
    historyOf(account),
    fundingOf(account, since),
    deps.warned && userId ? deps.warned({ userId, venueId: venue.venue.id, owner: account.owner }) : Promise.resolve([]),
  ]);
  const warnedBy = new Map(warnings.map((w) => [w.venueClientOrderId.toLowerCase(), w]));
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
  const replays: KeptReplay[] = [];
  const worked = await Promise.all(
    trips.map(async (trip) => {
      // From 10 bars before the entry bar, so the trade's replay keeps the bars it starts on; the figures read from the
      // entry bar on.
      const from = new Date(bucketOf(trip.openedAt) - REPLAY_BARS_BEFORE_ENTRY * MINUTE_MS);
      const key = `${trip.symbol}|${from.getTime()}`;
      let read = candleReads.get(key);
      if (!read) {
        read = candlesOf(trip.symbol, JOURNAL_CANDLE_INTERVAL, { limit: JOURNAL_CANDLES_PER_READ, since: from }).then((r) => r.value);
        candleReads.set(key, read);
      }
      const warned =
        trip.parts.flatMap((p) => {
          const w = p.opening && p.venueClientOrderId ? warnedBy.get(p.venueClientOrderId.toLowerCase()) : undefined;
          return w ? [w] : [];
        })[0] ?? null;
      const candles = await read;
      const trade = journalTrade(trip, plannedLevels(trip, orders.value), { candles, funding: funding.value, warned });
      replays.push({
        tradeId: trade.tradeId,
        complete: trade.excursion.complete,
        interval: JOURNAL_CANDLE_INTERVAL,
        bars: replayBarsOf(trip, candles),
        stops: stopTimeline(trip, orders.value).map((x) => ({ price: formatAmount(x.price), placedAt: x.placedAt.toISOString() })),
      });
      return trade;
    }),
  );
  const book = { venueId: account.venueId, owner: account.owner, subAccount: account.subAccount };
  await deps.store.keep(book, worked, now);
  await deps.store.keepReplays(book, replays, now);
  const onVenue = new Set(worked.map((t) => t.tradeId));
  const trades = (await deps.store.list(book, since, input.limit)).map(({ trade, storedAt }) => ({
    ...trade,
    storedAt: storedAt.toISOString(),
    source: onVenue.has(trade.tradeId) ? ('venue' as const) : ('record' as const),
  }));

  const known = trades.flatMap((t) => (t.netPnl === null ? [] : [t.netPnl]));
  const resolved = trades.flatMap((t) =>
    t.disciplined.netPnl === null || t.netPnl === null ? [] : [{ actual: t.netPnl, disciplined: t.disciplined.netPnl }],
  );
  const total = (xs: readonly string[]) => formatAmount(sum(xs.map((x) => parseAmount(x))));
  const journal: TradeJournal = {
    venue: { id: venue.venue.id, name: venue.venue.displayName, test: isTestVenue(venue.venue) },
    owner: account.owner,
    subAccount: account.subAccount,
    since: since.toISOString(),
    asOf: fills.asOf.toISOString(),
    trades,
    totals: {
      count: trades.length,
      netPnl: total(known),
      netUnknown: trades.length - known.length,
      disciplinedCount: resolved.length,
      actualNetPnlOfDisciplined: total(resolved.map((t) => t.actual)),
      disciplinedNetPnl: total(resolved.map((t) => t.disciplined)),
      rulesNetPnl: total(trades.flatMap((t) => (t.rules.netPnl === null ? [] : [t.rules.netPnl]))),
    },
  };
  return { journal, book };
}

/** A venue refusal (down, unknown account) answers as the journal being unavailable, in the venue's words. */
export function journalRefusal(err: unknown): TradeJournalError | undefined {
  if (err instanceof TradeJournalError) return err;
  if (err instanceof VenueRefusalError) return new TradeJournalError(err.refusal.detail, 'trade.journal_unavailable');
  return undefined;
}
