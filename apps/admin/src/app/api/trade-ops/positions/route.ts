import { tradeOpsRoute } from '@/lib/trade-ops/bff';
import { readPosition, readPositions } from '@/lib/trade-ops/desk-reads';
import { toPositionRows, checkLookup, type PositionsAnswer } from '@/lib/trade-ops/positions-model';
import { ok, refused, type Outcome } from '@/lib/trade-ops/outcome';
import { readMarkets } from '@/lib/trade-ops/reads';
import type { TradeCtx } from '@/lib/trade-ops/edge';

/**
 * Position lookup through svc-trade `admin.positions.get` (one position id) or `admin.positions.list` (one user id).
 * Bad input is refused first with its own code and nothing is sent. Market ids are named by symbol when the markets
 * list can be read; otherwise the id is shown. Every read is audited by the service.
 */
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function symbolsOf(ctx: TradeCtx): Promise<ReadonlyMap<string, string>> {
  const markets = await readMarkets(ctx);
  return new Map(markets.kind === 'ok' ? markets.data.map((m) => [m.id, m.symbol] as const) : []);
}

async function handler(ctx: TradeCtx, body: Record<string, unknown>): Promise<Outcome<PositionsAnswer>> {
  const check = checkLookup({ userId: body.userId, positionId: body.positionId });
  if (!check.ok) return refused(check.code, check.message, 400);
  const { userId, positionId } = check.value;
  if (positionId !== undefined) {
    if (!UUID.test(positionId)) return refused('trade_ops.positions_bad_input', 'A position id is a UUID.', 400);
    const one = await readPosition(ctx, positionId);
    if (one.kind !== 'ok') return one;
    if (userId !== undefined && one.data.userId !== userId)
      return refused('trade_ops.positions_user_mismatch', 'That position belongs to a different user id.', 404);
    return ok({ rows: toPositionRows([one.data], await symbolsOf(ctx)), nextCursor: null }, one.asOf);
  }
  const page = await readPositions(ctx, { accountId: userId as string });
  if (page.kind !== 'ok') return page;
  return ok({ rows: toPositionRows(page.data.rows, await symbolsOf(ctx)), nextCursor: page.data.nextCursor }, page.asOf);
}

export const POST = (req: Request) => tradeOpsRoute(req, handler);
