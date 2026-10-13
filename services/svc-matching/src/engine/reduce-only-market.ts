/**
 * Operator reduce-only of one market. Opens and increases refuse.
 * Reduce-only, close, and cancel stay. Resume is a second explicit door.
 * No duration, no SLO, not halt — halt blocks every submit.
 * Missing operator cannot apply — the engine does not invent a caller.
 */
import type { OrderBook } from './book.js';
import type { AmendResult, EngineOrder, MarketId, RejectReason, SubmitResult } from './types.js';

export const MARKET_REDUCE_ONLY = 'market_reduce_only' as const;

export type ReduceOnlyMarketRefuse = typeof MARKET_REDUCE_ONLY;

/** True when this qty on this side would open a flat or grow the net. */
export function wouldOpenOrIncrease(book: OrderBook | null, order: Pick<EngineOrder, 'accountId' | 'side' | 'qty' | 'orderId'>): boolean {
  if (book === null) return true;
  return book.wouldOpenOrIncrease(order.accountId, order.side, order.qty, order.orderId);
}

export function marketReduceOnlyRefuse(marketId: MarketId): RejectReason {
  return {
    code: MARKET_REDUCE_ONLY,
    message: `market ${marketId} is reduce-only — submits that would open or increase are refused`,
  };
}

export function reduceOnlyMarketSubmitResult(marketId: MarketId, orderId: string): SubmitResult {
  return {
    accepted: false,
    sequence: null,
    fills: [],
    resting: null,
    rejected: {
      ...marketReduceOnlyRefuse(marketId),
      message: `market ${marketId} is reduce-only — order ${orderId} would open or increase`,
    },
    cancellations: [],
    triggered: [],
  };
}

export function reduceOnlyMarketAmendResult(marketId: MarketId, orderId: string): AmendResult {
  return {
    accepted: false,
    orderId,
    sequence: null,
    version: null,
    priority: null,
    fills: [],
    resting: null,
    rejected: {
      ...marketReduceOnlyRefuse(marketId),
      message: `market ${marketId} is reduce-only — order ${orderId} would open or increase`,
    },
    cancellations: [],
    triggered: [],
  };
}

/** Last reduce-only / resume per market wins. Not a book — replay does not invent one. */
export function replayReduceOnlyMarkets(
  records: readonly { readonly kind: string; readonly marketId?: MarketId }[],
): ReadonlySet<MarketId> {
  const reduceOnly = new Set<MarketId>();
  for (const record of records) {
    if (record.marketId === undefined) continue;
    if (record.kind === 'reduce_only') reduceOnly.add(record.marketId);
    else if (record.kind === 'resume_reduce_only') reduceOnly.delete(record.marketId);
  }
  return reduceOnly;
}
