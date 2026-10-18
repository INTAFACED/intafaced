import { tradeOpsRoute } from '@/lib/trade-ops/bff';
import type { TradeCtx } from '@/lib/trade-ops/edge';
import { massCancelOutcome } from '@/lib/trade-ops/kill-switch-model';
import { handleMatchingRequest } from '@/lib/trade-ops/matching-edge';
import { refused, type Outcome } from '@/lib/trade-ops/outcome';

/**
 * Kill switch room actions. `halt_all` / `resume_all` go to svc-edge's venue doors through the same three steps as a market
 * control (propose, status, run) and need an APPROVED two-person approval. `mass_cancel` is fully checked, then answered
 * with its typed blocker; nothing is sent. There is no `toggle` here: stopping or resuming the trade module is the
 * console's two-founder flow at `/api/kill-switch` (the edge takes that door only with the operator token, never a session).
 */
export const dynamic = 'force-dynamic';

async function handler(ctx: TradeCtx, body: Record<string, unknown>): Promise<Outcome<unknown>> {
  switch (body.action) {
    case 'halt_all':
    case 'resume_all':
      return handleMatchingRequest(ctx, body);
    case 'mass_cancel':
      return massCancelOutcome(body, ctx.session.userId);
    default:
      return refused('trade_ops.bad_action', 'Unknown kill switch action.', 400);
  }
}

export const POST = (req: Request) => tradeOpsRoute(req, handler);
