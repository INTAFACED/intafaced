import { tradeOpsRoute } from '@/lib/trade-ops/bff';
import { BLOCKERS } from '@/lib/trade-ops/blockers';
import { carryOutBust, proposeBust, startReconcileSweep } from '@/lib/trade-ops/desk-reads';
import { readMatchingApproval } from '@/lib/trade-ops/matching-edge';
import { blocked, refused } from '@/lib/trade-ops/outcome';

/**
 * Actions for the Orders room.
 *   sweep         admin.orders.startReconcileSweep (J-cex-spot-18 #3): one run under the request id the page minted
 *   bust_propose  identity actionApproval.propose for trade.bust on one order (J-cex-spot-18 #4)
 *   bust          admin.orders.bust under an APPROVED request; svc-trade answers trade_bust_recipe_missing today
 * Still blocked, with their typed blockers: fills and history by id for a closed order (orders_by_id_cross_user_missing),
 * cancel for an operator (mass_cancel_operator_missing) and a single-order reconcile (reconcile_route_missing).
 */
export const dynamic = 'force-dynamic';

const ACTIONS = ['fills', 'history', 'cancel', 'reconcile', 'sweep', 'bust_propose', 'bust'] as const;
const TOKEN = /^[A-Za-z0-9_.:-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COUNT = /^(?:0|[1-9]\d{0,8})$/;

function reasonOf(body: Record<string, unknown>): string | null {
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  return reason.length >= 12 && reason.length <= 500 ? reason : null;
}

const REASON_REFUSED = () => refused('trade_ops.reason_too_short', 'A reason of 12 to 500 characters is required.', 400);

export const POST = (req: Request) =>
  tradeOpsRoute(req, async (ctx, body) => {
    const action = body.action;
    if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action))
      return refused('trade_ops.orders_bad_action', 'Unknown order action.', 400);
    if (action === 'sweep') {
      const reason = reasonOf(body);
      if (!reason) return REASON_REFUSED();
      if (typeof body.clientRequestId !== 'string' || !TOKEN.test(body.clientRequestId))
        return refused('trade_ops.request_id_invalid', 'A request id is required.', 400);
      return startReconcileSweep(ctx, { clientRequestId: body.clientRequestId, reason });
    }
    if (typeof body.orderId !== 'string' || !TOKEN.test(body.orderId))
      return refused('trade_ops.orders_bad_id', 'An order id is required.', 400);
    const orderId = body.orderId;
    if (action === 'bust_propose' || action === 'bust') {
      if (!UUID.test(orderId)) return refused('trade_ops.orders_bad_id', 'An order id is required.', 400);
      const reason = reasonOf(body);
      if (!reason) return REASON_REFUSED();
      if (action === 'bust_propose') {
        if (typeof body.expectedVersion !== 'string' || !COUNT.test(body.expectedVersion))
          return refused('trade_ops.bust_version_invalid', 'The fill count read with the order is required.', 400);
        return proposeBust(ctx, { orderId, expectedVersion: body.expectedVersion, reason });
      }
      if (typeof body.approvalId !== 'string' || !TOKEN.test(body.approvalId.trim()))
        return refused('trade_ops.approval_id_invalid', 'Enter the id of an APPROVED request.', 400);
      const approvalId = body.approvalId.trim();
      // The bust is bound to the approval's own operation id, which identity minted when it was proposed.
      const approval = await readMatchingApproval(ctx, approvalId);
      if (approval.kind !== 'ok') return approval;
      if (approval.data.status !== 'APPROVED')
        return refused(
          approval.data.status === 'PENDING' ? 'action_approval.pending' : 'action_approval.not_approved',
          approval.data.status === 'PENDING'
            ? 'This request is still waiting for a second operator. Nothing was sent.'
            : `This request is ${approval.data.status}, not APPROVED. Nothing was sent.`,
          409,
        );
      return carryOutBust(ctx, { orderId, approvalId, operationId: approval.data.operationId, reason });
    }
    if (action === 'cancel') {
      if (!reasonOf(body)) return REASON_REFUSED();
      return blocked(BLOCKERS.mass_cancel_operator_missing);
    }
    if (action === 'reconcile') return blocked(BLOCKERS.reconcile_route_missing);
    return blocked(BLOCKERS.orders_by_id_cross_user_missing);
  });
