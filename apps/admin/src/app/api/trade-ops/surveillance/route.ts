import { tradeOpsRoute } from '@/lib/trade-ops/bff';
import type { TradeCtx } from '@/lib/trade-ops/edge';
import { refused, type Outcome } from '@/lib/trade-ops/outcome';
import { adjudicationOutcome, readCasesOutcome } from '@/lib/trade-ops/surveillance-model';

/**
 * Surveillance room actions. `list` and `adjudicate` both end in the typed blocker surveillance_not_routed: the case
 * store is not reachable by operators. `adjudicate` first applies the law (no automatic decision, no sanction or fine)
 * and answers with the service's own refusal codes when the request breaks it.
 */
export const dynamic = 'force-dynamic';

async function handler(_ctx: TradeCtx, body: Record<string, unknown>): Promise<Outcome<unknown>> {
  switch (body.action) {
    case 'list':
      return readCasesOutcome();
    case 'adjudicate':
      return adjudicationOutcome(body);
    default:
      return refused('trade_ops.bad_action', 'Unknown surveillance action.', 400);
  }
}

export const POST = (req: Request) => tradeOpsRoute(req, handler);
