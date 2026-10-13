/**
 * Operator post-only of one market. Non-post-only submits refuse.
 * Post-only that would take still refuses — existing PO law.
 * Amends consult the same set. A non-post-only amend, or a price that would
 * cross, refuses before the book. A post-only amend that would not cross may rest.
 * Cancels stay. Resume is a second explicit door.
 * No duration, no SLO, not halt — halt blocks every submit.
 * Missing operator cannot apply — the engine does not invent a caller.
 */
import type { OrderBook } from './book.js';
import type { AmendResult, EngineAmend, EngineOrder, MarketId, RejectReason, SubmitResult } from './types.js';

export const MARKET_POST_ONLY = 'market_post_only' as const;

export type PostOnlyMarketRefuse = typeof MARKET_POST_ONLY;

/** True when this submit is already post-only. The engine does not invent a TIF. */
export function isPostOnlySubmit(order: Pick<EngineOrder, 'tif'>): boolean {
  return order.tif === 'PO';
}

export function marketPostOnlyRefuse(marketId: MarketId): RejectReason {
  return {
    code: MARKET_POST_ONLY,
    message: `market ${marketId} is post-only — non-post-only submits are refused`,
  };
}

/**
 * Same refusal submit uses. Null when this amend is not live, or when a
 * post-only amend would rest without crossing. Does not match and does not print.
 */
export function postOnlyAmendRefusal(book: OrderBook | null, marketId: MarketId, cmd: EngineAmend): AmendResult | null {
  if (book === null) return null;
  const live = book.amendTarget(cmd.orderId);
  if (!live) return null;
  const tif = cmd.tif ?? live.inheritedTif;
  if (tif !== 'PO') return postOnlyMarketAmendResult(marketId, cmd.orderId, false);
  if (amendWouldTake(book, live, cmd)) return postOnlyMarketAmendResult(marketId, cmd.orderId, true);
  return null;
}

function amendWouldTake(book: OrderBook, live: NonNullable<ReturnType<OrderBook['amendTarget']>>, cmd: EngineAmend): boolean {
  const price = cmd.price ?? live.price;
  if (live.kind === 'book') return price !== null && book.wouldCrossLimit(live.side, price);
  const stopPrice = cmd.stopPrice ?? live.stopPrice;
  if (stopPrice === null || !book.stopWouldTrigger(live.side, stopPrice)) return false;
  if (price === null) return true;
  return book.wouldCrossLimit(live.side, price);
}

export function postOnlyMarketAmendResult(marketId: MarketId, orderId: string, wouldTake: boolean): AmendResult {
  const detail = wouldTake ? `order ${orderId} would take` : `order ${orderId} is not post-only`;
  return {
    accepted: false,
    orderId,
    sequence: null,
    version: null,
    priority: null,
    fills: [],
    resting: null,
    rejected: {
      ...marketPostOnlyRefuse(marketId),
      message: `market ${marketId} is post-only — ${detail}`,
    },
    cancellations: [],
    triggered: [],
  };
}

export function postOnlyMarketSubmitResult(marketId: MarketId, orderId: string): SubmitResult {
  return {
    accepted: false,
    sequence: null,
    fills: [],
    resting: null,
    rejected: {
      ...marketPostOnlyRefuse(marketId),
      message: `market ${marketId} is post-only — order ${orderId} is not post-only`,
    },
    cancellations: [],
    triggered: [],
  };
}

/** Last post-only / resume per market wins. Not a book — replay does not invent one. */
export function replayPostOnlyMarkets(records: readonly { readonly kind: string; readonly marketId?: MarketId }[]): ReadonlySet<MarketId> {
  const postOnly = new Set<MarketId>();
  for (const record of records) {
    if (record.marketId === undefined) continue;
    if (record.kind === 'post_only') postOnly.add(record.marketId);
    else if (record.kind === 'resume_post_only') postOnly.delete(record.marketId);
  }
  return postOnly;
}
