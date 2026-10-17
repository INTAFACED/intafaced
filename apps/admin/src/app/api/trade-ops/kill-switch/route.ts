import { decodeSnapshot } from '@/lib/control-plane-contract';
import { tradeOpsRoute } from '@/lib/trade-ops/bff';
import { edgeCall, type TradeCtx } from '@/lib/trade-ops/edge';
import { checkToggle, massCancelOutcome, venueOutcome } from '@/lib/trade-ops/kill-switch-model';
import { refused, type Outcome } from '@/lib/trade-ops/outcome';

/**
 * Kill switch room actions. `toggle` is real: it validates like the edge does (reason, a different confirming
 * operator, an approval id) and sends POST /admin/kill-switches for the trade module. `halt_all`/`resume_all`
 * and `mass_cancel` are fully checked, then answered with their typed blocker; nothing is sent for those.
 */
export const dynamic = 'force-dynamic';

async function handler(ctx: TradeCtx, body: Record<string, unknown>): Promise<Outcome<unknown>> {
  switch (body.action) {
    case 'toggle': {
      const check = checkToggle(body, ctx.session.userId);
      if (!check.ok) return refused(check.code, check.message, 400);
      return edgeCall(ctx, {
        method: 'POST',
        path: '/admin/kill-switches',
        body: check.body,
        parse: (raw) => {
          const snap = decodeSnapshot(raw);
          if (!snap) return null;
          const extra = raw as { changed?: unknown; confirmOperatorId?: unknown };
          return {
            ...snap,
            changed: extra.changed === true,
            confirmOperatorId: typeof extra.confirmOperatorId === 'string' ? extra.confirmOperatorId : null,
          };
        },
      });
    }
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
