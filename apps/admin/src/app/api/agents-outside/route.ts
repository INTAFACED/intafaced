import { moduleDisabledResponse } from '@/lib/modules';
import { adminSessionErrorResponse, AdminSessionError, authorizeAdminRequest } from '@/lib/founder-session';
import { parseOutsideAction } from '@/lib/agents-outside/model';
import { runOutside } from '@/lib/agents-outside/server';

/**
 * The outside assistant connections desk (J-agents-21 #15). POST reads the connections or the desk's audit log, or
 * quarantines one connection, as the signed-in founder. A refusal keeps the service's code.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' };

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('more-ops');
  if (disabled) return disabled;
  try {
    const founder = await authorizeAdminRequest(request);
    const action = parseOutsideAction(await request.json().catch(() => null));
    if (!action) throw new AdminSessionError('admin.agents_outside_input', 400);
    const answer = await runOutside(founder, action);
    if (answer.kind !== 'ok') return Response.json({ code: answer.code }, { status: answer.status, headers: NO_STORE });
    return Response.json(answer.data, { headers: NO_STORE });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
