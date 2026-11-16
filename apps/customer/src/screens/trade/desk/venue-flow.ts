/**
 * The DOM on the venue spot desk (J-charts-desk-14 under the launch money model): the venue's own book, prints and the
 * person's own venue orders, read as the DOM's pure helpers (order-flow.ts) take them. Pure arithmetic: prices and amounts
 * stay decimal strings in and out, sums are scaled bigint, and nothing here holds a balance or sends anything.
 *
 * My place in the queue: the venue publishes price levels, not its orders, so the place is an estimate from its own book
 * and prints, never a fact. At my price the level's total less my own remaining size is the most that can be ahead of me
 * (time priority is the venue's and it does not publish it). The chance of a fill is the volume the venue printed at or
 * through my price, with the taker on the other side, over the owner's window (`queueFillWindowSeconds`), divided by what
 * must trade for my order to fill at most (that size ahead plus my remaining), capped at 1 and floored to 4 places: the
 * same method as today's queue (`traded_through_window`, svc-trade queue-position.ts), so with the size ahead an upper
 * bound the chance is a floor. A blank window shows no chance at all, never a default.
 */
import type { OrderBook } from '@intafaced/exchange-contract/schemas';
import type { AsOf, VenueMarket, VenuePrint } from '../../../features/trade/venue-api';
import { formatAmount } from '../../../shared/money';
import { scaled } from './order-math';
import type { FlowMarket, TapePrint } from './order-flow';

/**
 * The venue market as the DOM's market: its assets and steps. The door lists only markets we show, and the venue's own
 * preview refuses an order its market state does not take, in its words, so the chart's buttons stay on.
 */
export function flowMarketOf(market: Pick<VenueMarket, 'symbol' | 'baseAsset' | 'quoteAsset' | 'tickSize' | 'lotSize'>): FlowMarket {
  return {
    symbol: market.symbol,
    base: market.baseAsset,
    quote: market.quoteAsset,
    tickSize: market.tickSize,
    lotSize: market.lotSize,
    open: true,
  };
}

interface VenueLevels {
  symbol: string;
  bids: readonly { price: string; amount: string }[];
  asks: readonly { price: string; amount: string }[];
}

/**
 * One venue book read as the DOM's book. The venue publishes no sequence, so the read's own as-of time stands for it: the
 * ladder and the depth chart drawn from one read carry the same mark.
 */
export function venueBookAsOrderBook(read: Pick<AsOf<VenueLevels>, 'value' | 'asOf'>): OrderBook {
  const ms = Date.parse(read.asOf);
  const at = Number.isFinite(ms) && ms >= 0 ? ms : 0;
  return {
    symbol: read.value.symbol,
    bids: read.value.bids.map((l) => [l.price, l.amount] as [string, string]),
    asks: read.value.asks.map((l) => [l.price, l.amount] as [string, string]),
    timestamp: at,
    datetime: read.asOf,
    nonce: at,
  };
}

/** The venue's prints as time and sales reads them; a print whose taker the venue doesn't name keeps no side. */
export function venuePrintsAsTape(prints: readonly VenuePrint[]): TapePrint[] {
  return prints.map((p) => ({
    id: p.tradeId,
    timestamp: Date.parse(p.tradedAt),
    side: p.takerSide,
    price: p.price,
    amount: p.amount,
  }));
}

const ONE = 10n ** 18n;
/** Places of the estimate: a ratio, not money. 4 places is 0.01 percent. */
const ESTIMATE_STEP = 10n ** 14n;

export type VenueQueueEstimate =
  /** My price is not among the levels the venue published (past the read's depth, or the book moved since my order was read). */
  | { readonly kind: 'not_in_book' }
  | {
      readonly kind: 'ready';
      /** The venue's total resting at my price, mine included. */
      readonly levelTotal: string;
      /** My own remaining size, as the venue's order record has it. */
      readonly remaining: string;
      /** The most that can be ahead of me: the level less my remaining, never below zero. */
      readonly sizeAheadAtMost: string;
      readonly chance:
        | { readonly kind: 'unset' }
        | {
            readonly kind: 'estimate';
            /** 0..1, floored to 4 places. */
            readonly ratio: string;
            readonly windowSeconds: number;
            readonly windowStartMs: number;
            /** Volume printed at or through my price, the taker on the other side, inside the window. */
            readonly tradedThrough: string;
            /** What must trade for my order to fill, at most: the size ahead plus my remaining. */
            readonly sizeToFill: string;
            /** False when the prints read may not reach back to the window's start: the traded volume is then a floor. */
            readonly complete: boolean;
          };
    };

/**
 * Where my resting order stands on the venue's own book, and the estimated chance of a fill. `tapeAsOfMs` is the venue's
 * time of the prints read: the window ends there. `printsComplete` says the read reached back past the window's start (or
 * held every print the venue keeps).
 */
export function venueQueueEstimate(input: {
  side: 'buy' | 'sell';
  price: string;
  remaining: string;
  book: Pick<OrderBook, 'bids' | 'asks'>;
  prints: readonly TapePrint[];
  tapeAsOfMs: number;
  windowSeconds: number | null;
  printsComplete: boolean;
}): VenueQueueEstimate {
  const price = scaled(input.price);
  const remaining = scaled(input.remaining);
  if (price === null || remaining === null || remaining <= 0n) return { kind: 'not_in_book' };
  const levels = (input.side === 'buy' ? input.book.bids : input.book.asks) as readonly (readonly [string, string])[];
  const level = levels.find(([p]) => scaled(p) === price);
  const total = level ? scaled(level[1]) : null;
  if (total === null) return { kind: 'not_in_book' };
  const ahead = total > remaining ? total - remaining : 0n;
  const base = {
    kind: 'ready' as const,
    levelTotal: formatAmount(total),
    remaining: formatAmount(remaining),
    sizeAheadAtMost: formatAmount(ahead),
  };
  const window = input.windowSeconds;
  if (window === null || !Number.isInteger(window) || window <= 0) return { ...base, chance: { kind: 'unset' } };
  const windowStartMs = input.tapeAsOfMs - window * 1000;
  const other = input.side === 'buy' ? 'sell' : 'buy';
  let traded = 0n;
  for (const p of input.prints) {
    if (p.side !== other || !(p.timestamp >= windowStartMs && p.timestamp <= input.tapeAsOfMs)) continue;
    const at = scaled(p.price);
    const amount = scaled(p.amount);
    if (at === null || amount === null || amount <= 0n) continue;
    if (input.side === 'buy' ? at <= price : at >= price) traded += amount;
  }
  const toFill = ahead + remaining;
  const ratio = traded >= toFill ? ONE : (traded * ONE) / toFill;
  return {
    ...base,
    chance: {
      kind: 'estimate',
      ratio: formatAmount((ratio / ESTIMATE_STEP) * ESTIMATE_STEP),
      windowSeconds: window,
      windowStartMs,
      tradedThrough: formatAmount(traded),
      sizeToFill: formatAmount(toFill),
      complete: input.printsComplete,
    },
  };
}

/** Whether a prints read reaches back past `sinceMs`: fewer rows than asked for (all the venue keeps), or an older one. */
export function printsReach(prints: readonly TapePrint[], asked: number, sinceMs: number): boolean {
  if (prints.length < asked) return true;
  return prints.some((p) => p.timestamp < sinceMs);
}
