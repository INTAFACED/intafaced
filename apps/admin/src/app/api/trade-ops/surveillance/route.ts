import { tradeOpsRoute } from '@/lib/trade-ops/bff';
import type { TradeCtx } from '@/lib/trade-ops/edge';
import { refused, type Outcome } from '@/lib/trade-ops/outcome';
import { readSurveillanceCases } from '@/lib/trade-ops/matching-edge';
import { adjudicationOutcome } from '@/lib/trade-ops/surveillance-model';

/**
 * Surveillance room actions. `list` reads svc-matching's open cases through svc-edge. `adjudicate` first applies the law (no
 * automatic decision, no sanction or fine) and answers with the service's own refusal codes when the request breaks it;
 * a valid decision ends in the typed blocker surveillance_adjudicate_not_exposed, because svc-edge registers no such route.
 */
export const dynamic = 'force-dynamic';

async function handler(ctx: TradeCtx, body: Record<string, unknown>): Promise<Outcome<unknown>> {
  switch (body.action) {
    case 'list':
      return readSurveillanceCases(ctx);
    case 'adjudicate':
      return adjudicationOutcome(body);
    default:
      return refused('trade_ops.bad_action', 'Unknown surveillance action.', 400);
  }
}

export const POST = (req: Request) => tradeOpsRoute(req, handler);
