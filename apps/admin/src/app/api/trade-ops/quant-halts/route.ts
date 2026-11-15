import { randomUUID } from 'node:crypto';
import { tradeOpsRoute } from '@/lib/trade-ops/bff';
import { checkReason, type HaltOp } from '@/lib/trade-ops/quant-halts';
import {
  actionTypeOf,
  approveHaltApproval,
  confirmHalt,
  fileHaltApproval,
  haltOne,
  haltPayloadHash,
  proposeHalt,
  readHaltDesk,
  readHaltRequest,
} from '@/lib/trade-ops/quant-halts-calls';
import type { TradeCtx } from '@/lib/trade-ops/edge';
import { readMatchingApproval } from '@/lib/trade-ops/matching-edge';
import { ok, refused, type Outcome } from '@/lib/trade-ops/outcome';

/**
 * The live strategy desk on /more-ops/quant (J-algo-dev-11), through svc-trade `admin.quantLive.*` and identity's
 * two-person approvals.
 *
 *   POST { action: 'read' }                                   every live run, the halts, the requests waiting, the audit
 *   POST { action: 'halt', userId, strategyId, reason }       one operator halts one strategy
 *   POST { action: 'ask', op, haltId?, reason }               founder A: file the approval and record the request
 *   POST { action: 'now', op }                                one founder alone: refused, nothing changes
 *   POST { action: 'confirm', requestId }                     founder B: approve it in identity, then apply it
 */
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPS: readonly HaltOp[] = ['halt_all', 'restore', 'restore_all'];
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

async function handler(ctx: TradeCtx, body: Record<string, unknown>): Promise<Outcome<unknown>> {
  const action = body.action;
  if (action === 'read') return readHaltDesk(ctx);

  if (action === 'halt') {
    const userId = text(body.userId);
    const strategyId = text(body.strategyId);
    if (!userId || !strategyId) return refused('trade_ops.quant_halt_request_invalid', 'Choose a strategy to halt.', 400);
    const reason = checkReason(body.reason);
    if (!reason) return refused('trade_ops.reason_required', 'Write the reason (3 to 500 characters).', 400);
    return haltOne(ctx, { requestId: randomUUID(), userId, strategyId, reason });
  }

  if (action === 'ask' || action === 'now') {
    const op = OPS.find((o) => o === body.op);
    if (!op) return refused('trade_ops.quant_halt_request_invalid', 'Choose halt every strategy, restore one, or restore every one.', 400);
    // Halting every strategy and every restore need two founders: there is no one-founder door.
    if (action === 'now')
      return refused('trade_ops.quant_halt_second_founder_required', 'A second founder must confirm this. Nothing was changed.', 409);
    const reason = checkReason(body.reason);
    if (!reason) return refused('trade_ops.reason_required', 'Write the reason (3 to 500 characters).', 400);
    const haltId = op === 'restore' ? text(body.haltId) : null;
    if (op === 'restore' && !UUID.test(haltId ?? ''))
      return refused('trade_ops.quant_halt_request_invalid', 'Choose the halt to lift.', 400);
    const read = await readHaltDesk(ctx);
    if (read.kind !== 'ok') return read;
    // A retried ask answers the request this founder already filed for this change, so no second approval is filed.
    const mine = read.data.waiting.find(
      (w) => w.op === op && w.haltId === haltId && w.reason === reason && w.proposedBy.toLowerCase() === ctx.session.userId.toLowerCase(),
    );
    if (mine) return ok(mine, read.asOf);
    const requestId = randomUUID();
    const filed = await fileHaltApproval(ctx, { requestId, op, haltId, reason });
    if (filed.kind !== 'ok') return filed;
    return proposeHalt(ctx, { requestId, op, haltId, reason, approvalId: filed.data.approvalId });
  }

  if (action === 'confirm') {
    if (typeof body.requestId !== 'string' || !UUID.test(body.requestId))
      return refused('trade_ops.quant_halt_request_invalid', 'Choose a request.', 400);
    const request = await readHaltRequest(ctx, body.requestId);
    if (request.kind !== 'ok') return request;
    const r = request.data;
    if (r.status !== 'awaiting_second') return refused('trade_ops.quant_halt_request_decided', 'This request was already confirmed.', 409);
    if (r.proposedBy.toLowerCase() === ctx.session.userId.toLowerCase())
      return refused(
        'action_approval.same_person',
        'The founder who asked cannot confirm it. A different founder must sign in and confirm it.',
        409,
      );
    const approval = await readMatchingApproval(ctx, r.approvalId);
    if (approval.kind !== 'ok') return approval;
    if (approval.data.actionType !== actionTypeOf(r.op) || approval.data.targetId !== r.id)
      return refused('approval_mismatch', 'The approval on this request was filed for something else. Nothing was changed.', 409);
    if (approval.data.status === 'PENDING') {
      const approved = await approveHaltApproval(ctx, {
        approvalId: r.approvalId,
        expectedPayloadHash: haltPayloadHash({ requestId: r.id, op: r.op, haltId: r.haltId, reason: r.reason }),
      });
      if (approved.kind !== 'ok') return approved;
    } else if (approval.data.status !== 'APPROVED' && approval.data.status !== 'CONSUMED') {
      return refused('action_approval.not_approved', `This approval is ${approval.data.status}. Nothing was changed.`, 409);
    }
    return confirmHalt(ctx, { requestId: r.id, operationId: approval.data.operationId });
  }

  return refused('trade_ops.bad_action', 'Unknown action.', 400);
}

export const POST = (req: Request) => tradeOpsRoute(req, handler);
