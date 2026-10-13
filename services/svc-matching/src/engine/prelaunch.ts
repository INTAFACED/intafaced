/**
 * Operator prelaunch of one market. Public submits refuse until OPEN.
 * Cancel of nothing is a no-op. OPEN is a second explicit door.
 * No duration, no SLO, not halt — halt is a different door on a live book.
 * Missing operator cannot apply — the engine does not invent a caller.
 */
import type { AmendResult, MarketId, RejectReason, SubmitResult } from './types.js';

export const MARKET_PRELAUNCH = 'market_prelaunch' as const;

export type PrelaunchRefuse = typeof MARKET_PRELAUNCH;

export function marketPrelaunchRefuse(marketId: MarketId): RejectReason {
  return {
    code: MARKET_PRELAUNCH,
    message: `market ${marketId} is prelaunch — public submits are refused until open`,
  };
}

export function prelaunchSubmitResult(marketId: MarketId, orderId: string): SubmitResult {
  return {
    accepted: false,
    sequence: null,
    fills: [],
    resting: null,
    rejected: {
      ...marketPrelaunchRefuse(marketId),
      message: `market ${marketId} is prelaunch — order ${orderId} not processed`,
    },
    cancellations: [],
    triggered: [],
  };
}

export function prelaunchAmendResult(marketId: MarketId, orderId: string): AmendResult {
  return {
    accepted: false,
    orderId,
    sequence: null,
    version: null,
    priority: null,
    fills: [],
    resting: null,
    rejected: {
      ...marketPrelaunchRefuse(marketId),
      message: `market ${marketId} is prelaunch — order ${orderId} not processed`,
    },
    cancellations: [],
    triggered: [],
  };
}

/** Last prelaunch / open per market wins. Not a book — replay does not invent one. Halt is a different door. */
export function replayPrelaunchMarkets(records: readonly { readonly kind: string; readonly marketId?: MarketId }[]): ReadonlySet<MarketId> {
  const prelaunch = new Set<MarketId>();
  for (const record of records) {
    if (record.marketId === undefined) continue;
    if (record.kind === 'prelaunch') prelaunch.add(record.marketId);
    else if (record.kind === 'open') prelaunch.delete(record.marketId);
  }
  return prelaunch;
}

/**
 * Markets an approved OPEN has listed. Control state, not a book: a market that
 * was opened must stay visible to svc-trade (`trade.matching_market_missing`)
 * even while it holds no book. Callers subtract expired/delisted markets.
 */
export function replayOpenedMarkets(records: readonly { readonly kind: string; readonly marketId?: MarketId }[]): ReadonlySet<MarketId> {
  const opened = new Set<MarketId>();
  for (const record of records) {
    if (record.marketId !== undefined && record.kind === 'open') opened.add(record.marketId);
  }
  return opened;
}
