import { moduleDisabledResponse } from '@/lib/modules';
import { adminSessionErrorResponse, AdminSessionError, authorizeAdminRequest } from '@/lib/founder-session';
import { parseAgentsLogAction } from '@/lib/agents-log/model';
import { runAgentsLog } from '@/lib/agents-log/server';

/**
 * The agent action log desk (AG-audit-01, AG-audit-02). POST reads one customer's agent actions, exports them, or opens
 * one kept transcript, as the signed-in founder: svc-agents checks the reason against the owner's list and writes one
 * audit row per read before it answers. A POST because every read writes that row. A refusal keeps the service's code.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' };

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('more-ops');
  if (disabled) return disabled;
  try {
    const founder = await authorizeAdminRequest(request);
    const action = parseAgentsLogAction(await request.json().catch(() => null));
    if (!action) throw new AdminSessionError('admin.agents_log_input', 400);
    const answer = await runAgentsLog(founder, action);
    if (answer.kind !== 'ok') return Response.json({ code: answer.code }, { status: answer.status, headers: NO_STORE });
    return Response.json(answer.data, { headers: NO_STORE });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
