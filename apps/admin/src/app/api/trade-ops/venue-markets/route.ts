import { tradeOpsRoute } from '@/lib/trade-ops/bff';
import type { TradeCtx } from '@/lib/trade-ops/edge';
import { ok, refused, type Outcome } from '@/lib/trade-ops/outcome';
import {
  approvedVenueChange,
  proposeVenueChange,
  readVenueMarkets,
  venueChangeRequest,
  writeVenueChange,
} from '@/lib/trade-ops/venue-markets-calls';

/**
 * The venue markets desk (J-cex-spot-16), through svc-trade `admin.venueMarkets.*` and identity's two-person approvals.
 *
 *   POST { action: 'read' }                                         every venue market, ours beside the venue's own
 *   POST { action: 'propose', change, symbol, <fields>, reason }    file the request at the version the desk reads now
 *   POST { action: 'apply',   change, symbol, <fields>, reason, approvalId }   write it, once a second founder APPROVED it
 *
 * `change` is listing (opensAt), routing (routing: show | close_only | stop), limits (maxOrderQty, maxOrderNotional) or
 * delisting (delistsAt). A blank or malformed value, or a limit above the venue's own, refuses with svc-trade's own code
 * before anything is filed; svc-trade checks it all again. Nothing here moves money or touches an open order.
 */
export const dynamic = 'force-dynamic';

const TOKEN = /^[A-Za-z0-9_.:-]{1,128}$/;

async function handler(ctx: TradeCtx, body: Record<string, unknown>): Promise<Outcome<unknown>> {
  if (body.action === 'read') return readVenueMarkets(ctx);
  if (body.action !== 'propose' && body.action !== 'apply') return refused('trade_ops.bad_action', 'Unknown venue markets action.', 400);
  const req = await venueChangeRequest(ctx, body);
  if (req.kind !== 'ok') return req;
  if (body.action === 'propose') {
    const filed = await proposeVenueChange(ctx, req.data);
    return filed.kind === 'ok'
      ? ok(
          { approval: filed.data, payloadHash: req.data.hashAt(req.data.currentVersion), expectedVersion: req.data.currentVersion },
          filed.asOf,
        )
      : filed;
  }
  const approvalId = typeof body.approvalId === 'string' ? body.approvalId.trim() : '';
  if (!TOKEN.test(approvalId)) return refused('trade_ops.approval_id_invalid', 'Enter the id of an APPROVED request.', 400);
  const approval = await approvedVenueChange(ctx, approvalId, req.data);
  if (approval.kind !== 'ok') return approval;
  return writeVenueChange(ctx, req.data, approval.data);
}

export const POST = (req: Request) => tradeOpsRoute(req, handler);
