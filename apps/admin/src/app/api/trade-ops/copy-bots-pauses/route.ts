import { randomUUID } from 'node:crypto';
import { tradeOpsRoute } from '@/lib/trade-ops/bff';
import { checkScope } from '@/lib/trade-ops/copy-bots-pauses';
import {
  actionTypeOf,
  approvePauseApproval,
  confirmPause,
  filePauseApproval,
  pausePayloadHash,
  proposePause,
  readPauseDesk,
  readPauseRequest,
} from '@/lib/trade-ops/copy-bots-pauses-calls';
import type { TradeCtx } from '@/lib/trade-ops/edge';
import { readMatchingApproval } from '@/lib/trade-ops/matching-edge';
import { refused, type Outcome } from '@/lib/trade-ops/outcome';

/**
 * The kill switch's Copy and bots tab (CB-ops-03, J-copy-bots-otc-12), through svc-trade `copy.ops.pauses.*` and
 * identity's two-person approvals. Every pause and every resume needs two founders.
 *
 *   POST { action: 'read' }                              the scopes paused now and the requests waiting
 *   POST { action: 'ask', op, scope: { kind, value } }    founder A: file the approval and record the request
 *   POST { action: 'now', op, scope }                    one founder alone: refused, nothing changes
 *   POST { action: 'confirm', requestId }                founder B: approve it in identity, then apply it
 */
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(ctx: TradeCtx, body: Record<string, unknown>): Promise<Outcome<unknown>> {
  const action = body.action;
  if (action === 'read') return readPauseDesk(ctx);

  if (action === 'ask' || action === 'now') {
    const op = body.op;
    if (op !== 'pause' && op !== 'resume') return refused('trade_ops.copy_bots_op_invalid', 'Choose pause or resume.', 400);
    const scope = body.scope && typeof body.scope === 'object' ? (body.scope as Record<string, unknown>) : {};
    const checked = checkScope(scope.kind, scope.value);
    if (!checked.ok) return refused('trade_ops.copy_bots_scope_invalid', checked.message, 400);
    // There is no one-founder change: svc-trade applies a pause or a resume only when a second founder confirms it.
    if (action === 'now') {
      return refused('trade_ops.copy_bots_second_founder_required', 'A second founder must confirm this. Nothing was changed.', 409);
    }
    // Refused here before anything is filed when the scope is already in the state asked for (svc-trade refuses it too).
    const desk = await readPauseDesk(ctx);
    if (desk.kind !== 'ok') return desk;
    const active = desk.data.paused.some((p) => p.scope.kind === checked.scope.kind && p.scope.value === checked.scope.value);
    if (op === 'pause' && active) return refused('trade_ops.copy_bots_scope_already_paused', 'This scope is already paused.', 409);
    if (op === 'resume' && !active) return refused('trade_ops.copy_bots_scope_not_paused', 'This scope is not paused.', 409);
    const requestId = randomUUID();
    const filed = await filePauseApproval(ctx, { requestId, op, scope: checked.scope });
    if (filed.kind !== 'ok') return filed;
    return proposePause(ctx, { requestId, op, scope: checked.scope, approvalId: filed.data.approvalId });
  }

  if (action === 'confirm') {
    if (typeof body.requestId !== 'string' || !UUID.test(body.requestId))
      return refused('trade_ops.copy_bots_request_invalid', 'Choose a request.', 400);
    const request = await readPauseRequest(ctx, body.requestId);
    if (request.kind !== 'ok') return request;
    const r = request.data;
    if (r.status !== 'awaiting_second') return refused('trade_ops.copy_bots_request_decided', 'This request was already confirmed.', 409);
    if (r.proposedBy.toLowerCase() === ctx.session.userId.toLowerCase()) {
      return refused(
        'action_approval.same_person',
        'The founder who asked cannot confirm it. A different founder must sign in and confirm it.',
        409,
      );
    }
    const approval = await readMatchingApproval(ctx, r.approvalId);
    if (approval.kind !== 'ok') return approval;
    if (approval.data.actionType !== actionTypeOf(r.op) || approval.data.targetId !== r.id) {
      return refused('approval_mismatch', 'The approval on this request was filed for something else. Nothing was changed.', 409);
    }
    if (approval.data.status === 'PENDING') {
      const approved = await approvePauseApproval(ctx, {
        approvalId: r.approvalId,
        expectedPayloadHash: pausePayloadHash({ requestId: r.id, op: r.op, scope: r.scope }),
      });
      if (approved.kind !== 'ok') return approved;
    } else if (approval.data.status !== 'APPROVED' && approval.data.status !== 'CONSUMED') {
      return refused('action_approval.not_approved', `This approval is ${approval.data.status}. Nothing was changed.`, 409);
    }
    return confirmPause(ctx, { requestId: r.id, operationId: approval.data.operationId });
  }

  return refused('trade_ops.bad_action', 'Unknown action.', 400);
}

export const POST = (req: Request) => tradeOpsRoute(req, handler);
