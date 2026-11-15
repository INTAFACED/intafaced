import { moduleDisabledResponse } from '@/lib/modules';
import { adminSessionErrorResponse, AdminSessionError, authorizeAdminRequest } from '@/lib/founder-session';
import { parseRoutesAction } from '@/lib/agents-routes/model';
import { runRoutes } from '@/lib/agents-routes/server';

/**
 * The model routing table desk (J-agents-20). POST reads the table, or proposes, withdraws or confirms one change, as
 * the signed-in founder: svc-agents holds the two-founder rule and writes the audit row before it answers. A refusal
 * keeps the service's code.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' };

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('more-ops');
  if (disabled) return disabled;
  try {
    const founder = await authorizeAdminRequest(request);
    const action = parseRoutesAction(await request.json().catch(() => null));
    if (!action) throw new AdminSessionError('admin.agents_routes_input', 400);
    const answer = await runRoutes(founder, action);
    if (answer.kind !== 'ok') return Response.json({ code: answer.code }, { status: answer.status, headers: NO_STORE });
    return Response.json(answer.data, { headers: NO_STORE });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
