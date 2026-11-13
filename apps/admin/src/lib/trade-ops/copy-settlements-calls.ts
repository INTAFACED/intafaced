import 'server-only';
import { serviceCode } from './approvals';
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

/**
 * A blank window (empty or null) goes to svc-trade, which refuses it by name (`trade.copy_settlement_window_required`);
 * anything that is not a window string refuses here. The service's own code is put on its refusal.
 */
export async function reconcileSettlements(ctx: TradeCtx, window: unknown): Promise<Outcome<ReconcileResult>> {
  if (window !== null && window !== '' && !isSettlementWindow(window))
    return refused('trade.copy_settlement_window_required', WINDOW_REQUIRED, 400);
  const o = await edgeCall(
    ctx,
    trpcSpec('trade', 'copy.ops.settlements.reconcile', 'query', { window: window === '' ? null : window }, parseReconcileResult),
  );
  if (o.kind !== 'refused') return o;
  const code = serviceCode(o.code, o.message);
  return code === o.code ? o : { ...o, code, message: o.message.replace(/\s*\[[a-z_.]+\]\s*$/, '') };
}

export function readFollowAccounting(ctx: TradeCtx, followId: string): Promise<Outcome<FollowAccounting>> {
  return edgeCall(ctx, trpcSpec('trade', 'copy.ops.settlements.follow', 'query', { followId }, parseFollowAccounting));
}
