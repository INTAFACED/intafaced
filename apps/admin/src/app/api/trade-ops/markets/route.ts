import { tradeOpsRoute } from '@/lib/trade-ops/bff';
import { handleMatchingRequest } from '@/lib/trade-ops/matching-edge';

/**
 * POST /api/trade-ops/markets: the seven per-market matching controls, in three steps (body `step`):
 *   propose: file the two-person approval at identity (returns the approval id, payload hash and status);
 *   status:  read that approval back, so a PENDING one is shown as pending;
 *   run:     send the control to svc-edge `/admin/trade-ops/matching/markets/:id/...` once the approval is APPROVED.
 * Every refusal (missing approval, same person, matching unconfigured) comes back as the service said it.
 */
export const dynamic = 'force-dynamic';

export const POST = (req: Request) => tradeOpsRoute(req, handleMatchingRequest);
