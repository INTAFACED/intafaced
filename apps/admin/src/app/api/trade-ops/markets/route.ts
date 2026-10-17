import { BLOCKERS } from '@/lib/trade-ops/blockers';
import { tradeOpsRoute } from '@/lib/trade-ops/bff';
import { validateMarketAction } from '@/lib/trade-ops/markets-model';
import { blocked, refused } from '@/lib/trade-ops/outcome';

/**
 * POST /api/trade-ops/markets: halt, reduce-only, post-only, resume or delist one market.
 * The input is checked here (reason, two different people, symbol typed back for delist) and then refused with the
 * real blocker, because svc-edge has no operator route to svc-matching yet. Nothing is sent and nothing is faked.
 */
export const dynamic = 'force-dynamic';

export const POST = (req: Request) =>
  tradeOpsRoute(req, async (ctx, body) => {
    const check = validateMarketAction(body, ctx.session.userId);
    if (!check.ok) return refused(check.code, check.message, 400);
    return blocked(BLOCKERS.matching_not_routed);
  });
