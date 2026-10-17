import { tradeOpsRoute } from '@/lib/trade-ops/bff';
import type { TradeCtx } from '@/lib/trade-ops/edge';
import { refused, type Outcome } from '@/lib/trade-ops/outcome';
import { limitEditOutcome } from '@/lib/trade-ops/risk-limits-model';
import { readMarkets } from '@/lib/trade-ops/reads';

/**
 * Risk limits room action `edit`: checks the new value against the market's own tick/lot rules (using the markets
 * the service returns now), then answers with the typed blocker risk_limits_no_operator_api. Nothing is sent: there
 * is no operator procedure to change a limit.
 */
export const dynamic = 'force-dynamic';

async function handler(ctx: TradeCtx, body: Record<string, unknown>): Promise<Outcome<unknown>> {
  if (body.action !== 'edit') return refused('trade_ops.bad_action', 'Unknown risk limits action.', 400);
  const markets = await readMarkets(ctx);
  if (markets.kind !== 'ok') return markets;
  return limitEditOutcome(body, markets.data, ctx.session.userId);
}

export const POST = (req: Request) => tradeOpsRoute(req, handler);
