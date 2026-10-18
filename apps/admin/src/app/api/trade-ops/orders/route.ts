import { tradeOpsRoute } from '@/lib/trade-ops/bff';
import { BLOCKERS } from '@/lib/trade-ops/blockers';
import { blocked, refused } from '@/lib/trade-ops/outcome';

/**
 * Actions for the Orders room. Each one is a real, validated request whose service does not exist, so each answers
 * with its typed blocker: fills and history (orders_by_id_cross_user_missing), cancel for an operator
 * (mass_cancel_operator_missing) and starting a reconcile (reconcile_route_missing). Nothing is sent to the edge.
 */
export const dynamic = 'force-dynamic';

const ACTIONS = ['fills', 'history', 'cancel', 'reconcile'] as const;
const TOKEN = /^[A-Za-z0-9_.:-]{1,128}$/;

export const POST = (req: Request) =>
  tradeOpsRoute(req, async (_ctx, body) => {
    const action = body.action;
    if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action))
      return refused('trade_ops.orders_bad_action', 'Unknown order action.', 400);
    if (typeof body.orderId !== 'string' || !TOKEN.test(body.orderId))
      return refused('trade_ops.orders_bad_id', 'An order id is required.', 400);
    if (action === 'cancel') {
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (reason.length < 12) return refused('trade_ops.reason_too_short', 'A reason of at least 12 characters is required.', 400);
      return blocked(BLOCKERS.mass_cancel_operator_missing);
    }
    if (action === 'reconcile') return blocked(BLOCKERS.reconcile_route_missing);
    return blocked(BLOCKERS.orders_by_id_cross_user_missing);
  });
