import 'server-only';
import { authorizeAdminRequest, adminSessionErrorResponse } from '@/lib/founder-session';
import type { TradeCtx } from './edge';
import type { Outcome } from './outcome';

/**
 * Shared shell of every /api/trade-ops/<room> route: founder session + CSRF + origin, JSON body, then the room's
 * handler, whose Outcome goes back as-is (status 200 for ok, the refusal's own status otherwise).
 */

export async function tradeOpsRoute(request: Request, handler: (ctx: TradeCtx, body: Record<string, unknown>) => Promise<Outcome<unknown>>): Promise<Response> {
  let ctx: TradeCtx;
  try {
    ctx = await authorizeAdminRequest(request);
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
  let body: Record<string, unknown> = {};
  if (request.method === 'POST') {
    const raw: unknown = await request.json().catch(() => null);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      return Response.json({ kind: 'refused', code: 'trade_ops.bad_body', message: 'A JSON object body is required.', status: 400, blocker: null, asOf: new Date().toISOString() }, { status: 400 });
    body = raw as Record<string, unknown>;
  }
  const outcome = await handler(ctx, body);
  const status = outcome.kind === 'ok' ? 200 : outcome.kind === 'refused' ? outcome.status : 502;
  return Response.json(outcome, { status: status >= 200 && status < 600 ? status : 502, headers: { 'cache-control': 'no-store' } });
}
