import { moduleDisabledResponse } from '@/lib/modules';
import { adminSessionErrorResponse, AdminSessionError, authorizeAdminRequest } from '@/lib/founder-session';
import { parseFleetAction } from '@/lib/agents-fleet/model';
import { runFleet } from '@/lib/agents-fleet/server';

/**
 * The agent fleet desk (AG-registry-01, AG-control-02). POST reads the registry, exports it, or runs one switch, as the
 * signed-in founder: svc-agents writes one audit row per export and per action before it answers, and holds the
 * two-founder rule for every restore. A POST for the registry read too, so one route carries the desk. A refusal keeps
 * the service's code.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' };

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('more-ops');
  if (disabled) return disabled;
  try {
    const founder = await authorizeAdminRequest(request);
    const action = parseFleetAction(await request.json().catch(() => null));
    if (!action) throw new AdminSessionError('admin.agents_fleet_input', 400);
    const answer = await runFleet(founder, action);
    if (answer.kind !== 'ok') return Response.json({ code: answer.code }, { status: answer.status, headers: NO_STORE });
    return Response.json(answer.data, { headers: NO_STORE });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
