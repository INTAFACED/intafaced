import { moduleDisabledResponse } from '@/lib/modules';
import { adminSessionErrorResponse, AdminSessionError, authorizeAdminRequest } from '@/lib/founder-session';
import { parseAlertsAction } from '@/lib/agents-alerts/model';
import { runAlerts } from '@/lib/agents-alerts/server';

/**
 * The agent alert desk (AG-analytics-02, AG-guardrails-02). POST reads the rules and alerts, runs the evaluator, stores a
 * rule, reads the policy baseline, sets this environment's override or checks a rule, as the signed-in founder. One
 * route carries the desk; a refusal keeps the service's code.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' };

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('more-ops');
  if (disabled) return disabled;
  try {
    const founder = await authorizeAdminRequest(request);
    const action = parseAlertsAction(await request.json().catch(() => null));
    if (!action) throw new AdminSessionError('admin.agents_alerts_input', 400);
    const answer = await runAlerts(founder, action);
    if (answer.kind !== 'ok') return Response.json({ code: answer.code }, { status: answer.status, headers: NO_STORE });
    return Response.json(answer.data, { headers: NO_STORE });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
