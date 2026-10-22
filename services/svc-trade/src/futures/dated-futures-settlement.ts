/**
 * Dated futures settlement job (CARD F3 / PTX-M10-R03).
 *
 * Hitch: existing `runDatedFuturesExpiryTick` (owner decimal fixing only) +
 * existing `planClose` recipes — `futuresRealizeProfit`, `futuresRealizeLoss`,
 * `futuresMarginRelease`. Does not invent a fixing. Does not recut router.ts,
 * trade-service.ts, futures-jobs.ts, types.ts, or ccxt-errors.ts.
 *
 * Not a wall-clock cron. Given a dated market past expiry and an owner decimal
 * fixing string, posts balanced ledger-client recipes. Blank/invalid fixing →
 * `trade.dated_futures_settlement_price_unset` and zero posts. lastTrade / mark
 * are accepted only so tests can prove they are ignored.
 *
 * Idempotent on settlement id (`dated-settle:${positionId}`).
 */
import type { LedgerClient, PostRequest } from '@intafaced/ledger-client';
import { planClose, type ClosePosition } from './close-planner.js';
import {
  DATED_FUTURES_SETTLEMENT_PRICE_UNSET,
  runDatedFuturesExpiryTick,
  type DatedFuturesSettlementResult,
  type FuturesContractStyle,
} from './dated-futures.js';

export { DATED_FUTURES_SETTLEMENT_PRICE_UNSET };

/** Stable settlement id — one close per position, never per attempt. */
export function datedSettlementIdFor(positionId: string): string {
  return `dated-settle:${positionId}`;
}

export type DatedFuturesSettlementPosition = ClosePosition;

export type DatedFuturesSettlementJobResult =
  | (DatedFuturesSettlementResult & { readonly posts: readonly PostRequest[] })
  | {
      readonly status: 'settled';
      readonly settlementPrice: string;
      readonly source: 'owner_fixing';
      readonly posts: readonly PostRequest[];
      readonly settlementIds: readonly string[];
    };

export async function runDatedFuturesSettlementJob(input: {
  readonly style: FuturesContractStyle | null;
  readonly expiryAt: Date | null;
  readonly now: Date;
  /** Owner-published settlement/fixing price (decimal string). Empty refuses. */
  readonly ownerSettlementPrice: string | null | undefined;
  /** MUST NOT be used. Present so tests can prove last-trade is not settlement. */
  readonly lastTradePrice?: string | null;
  /** MUST NOT be used. Present so tests can prove mark is not settlement. */
  readonly markPrice?: string | null;
  readonly positions: readonly DatedFuturesSettlementPosition[];
  readonly ledger: Pick<LedgerClient, 'post'>;
}): Promise<DatedFuturesSettlementJobResult> {
  void input.lastTradePrice;
  void input.markPrice;
  const resolved = runDatedFuturesExpiryTick({
    style: input.style,
    expiryAt: input.expiryAt,
    now: input.now,
    ownerSettlementPrice: input.ownerSettlementPrice,
    lastTradePrice: input.lastTradePrice,
    markPrice: input.markPrice,
  });
  if (resolved.status !== 'ready') {
    return { ...resolved, posts: [] };
  }

  const posts: PostRequest[] = [];
  const settlementIds: string[] = [];
  for (const position of input.positions) {
    const settlementId = datedSettlementIdFor(position.positionId);
    const plan = planClose({
      closeId: settlementId,
      position,
      exitPrice: resolved.settlementPrice,
    });
    if (!plan.close) continue;
    for (const req of plan.recipes) {
      await input.ledger.post(req);
      posts.push(req);
    }
    settlementIds.push(settlementId);
  }

  return {
    status: 'settled',
    settlementPrice: resolved.settlementPrice,
    source: 'owner_fixing',
    posts,
    settlementIds,
  };
}
