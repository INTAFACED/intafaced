import { tradeOpsRoute } from '@/lib/trade-ops/bff';
import { reconcileSettlements } from '@/lib/trade-ops/copy-settlements-calls';
import type { TradeCtx } from '@/lib/trade-ops/edge';
import { refused, type Outcome } from '@/lib/trade-ops/outcome';

/**
 * Copy settlement oversight (CB-ops-02), through svc-trade `copy.ops.settlements.*`. Read only.
 *
 *   POST { action: 'reconcile', window }   every lead fee share in the window judged again, and the counts
 */
export const dynamic = 'force-dynamic';

async function handler(ctx: TradeCtx, body: Record<string, unknown>): Promise<Outcome<unknown>> {
  if (body.action === 'reconcile') return reconcileSettlements(ctx, body.window);
  return refused('trade_ops.bad_action', 'Unknown settlement action.', 400);
}

export const POST = (req: Request) => tradeOpsRoute(req, handler);
