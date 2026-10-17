import { tradeOpsRoute } from '@/lib/trade-ops/bff';
import { BLOCKERS } from '@/lib/trade-ops/blockers';
import { checkLookup } from '@/lib/trade-ops/positions-model';
import { blocked, refused } from '@/lib/trade-ops/outcome';

/**
 * Position lookup. Positions are readable only by their owner today, so a valid search answers with the typed
 * blocker positions_cross_user_missing; bad input is refused first with its own code. Nothing is sent to the edge.
 */
export const dynamic = 'force-dynamic';

export const POST = (req: Request) =>
  tradeOpsRoute(req, async (_ctx, body) => {
    const check = checkLookup({ userId: body.userId, positionId: body.positionId });
    if (!check.ok) return refused(check.code, check.message, 400);
    return blocked(BLOCKERS.positions_cross_user_missing);
  });
