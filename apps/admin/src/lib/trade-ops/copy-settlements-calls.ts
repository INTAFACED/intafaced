import 'server-only';
import { edgeCall, trpcSpec, type TradeCtx } from './edge';
import { refused, type Outcome } from './outcome';
import {
  WINDOW_REQUIRED,
  isSettlementWindow,
  parseFollowAccounting,
  parseReconcileResult,
  parseSettlementList,
  type FollowAccounting,
  type ReconcileResult,
  type SettlementList,
} from './copy-settlements';

/**
 * The calls behind copy settlement oversight. Server only: each is a real read of svc-trade (`copy.ops.settlements.*`)
 * through svc-edge with the signed-in founder's own token. Read only; nothing is cached or retried.
 */

export function readSettlements(ctx: TradeCtx): Promise<Outcome<SettlementList>> {
  return edgeCall(ctx, trpcSpec('trade', 'copy.ops.settlements.list', 'query', {}, parseSettlementList));
}

/** A blank window refuses here before anything is read, as svc-trade refuses it (`trade.copy_settlement_window_required`). */
export async function reconcileSettlements(ctx: TradeCtx, window: unknown): Promise<Outcome<ReconcileResult>> {
  if (!isSettlementWindow(window)) return refused('trade.copy_settlement_window_required', WINDOW_REQUIRED, 400);
  return edgeCall(ctx, trpcSpec('trade', 'copy.ops.settlements.reconcile', 'query', { window }, parseReconcileResult));
}

export function readFollowAccounting(ctx: TradeCtx, followId: string): Promise<Outcome<FollowAccounting>> {
  return edgeCall(ctx, trpcSpec('trade', 'copy.ops.settlements.follow', 'query', { followId }, parseFollowAccounting));
}
