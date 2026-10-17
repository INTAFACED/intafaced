import { tradeOpsRoute } from '@/lib/trade-ops/bff';
import type { TradeCtx } from '@/lib/trade-ops/edge';
import { massCancelOutcome, venueOutcome } from '@/lib/trade-ops/kill-switch-model';
import { refused, type Outcome } from '@/lib/trade-ops/outcome';

/**
 * Kill switch room actions. `halt_all`/`resume_all` and `mass_cancel` are fully checked, then answered with their
 * typed blocker; nothing is sent. There is no `toggle` here: stopping or resuming the trade module is the console's
 * two-founder flow at `/api/kill-switch` (the edge takes that door only with the operator token, never a session).
 */
export const dynamic = 'force-dynamic';

async function handler(ctx: TradeCtx, body: Record<string, unknown>): Promise<Outcome<unknown>> {
  switch (body.action) {
    case 'halt_all':
    case 'resume_all':
      return venueOutcome(body, ctx.session.userId);
    case 'mass_cancel':
      return massCancelOutcome(body, ctx.session.userId);
    default:
      return refused('trade_ops.bad_action', 'Unknown kill switch action.', 400);
  }
}

export const POST = (req: Request) => tradeOpsRoute(req, handler);
