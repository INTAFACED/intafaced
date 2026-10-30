import { moduleDisabledResponse } from '@/lib/modules';
import { adminSessionErrorResponse, AdminSessionError, authorizeAdminRequest, upstreamCodeOf } from '@/lib/founder-session';
import { parseControlRunList } from '@/lib/ledger/reconciliation';
import { listRunsAsFounder } from '@/lib/ledger/reconciliation-server';
import { listReconciliationControlRunsInputSchema } from '@intafaced/contracts/ledger-reconciliation';

/**
 * One reconciliation control's evaluations, newest first (J-ops-console-07 step 6, OPS-reconciliation-02).
 *
 * GET `?controlId=<uuid>[&limit=<1..500>]` reads them as the signed-in founder, through svc-edge, and stamps when it read them.
 * A paused or retired control keeps every evaluation, so this works in every state. svc-ledger's refusals come back with its
 * own code; a 2xx that is not this control's list is not reported as one.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('ledger');
  if (disabled) return disabled;
  try {
    const { session, config } = await authorizeAdminRequest(request);
    const params = new URL(request.url).searchParams;
    const limit = params.get('limit');
    const input = listReconciliationControlRunsInputSchema.safeParse({
      controlId: params.get('controlId') ?? undefined,
      ...(limit === null ? {} : { limit: /^\d{1,3}$/.test(limit) ? Number(limit) : Number.NaN }),
    });
    if (!input.success) throw new AdminSessionError('admin.request_invalid', 400, 'edge.invalid_reconciliation_control');
    const answer = await listRunsAsFounder(session, config, input.data);
    if (!answer) throw new AdminSessionError('admin.upstream_unavailable', 503);
    if (answer.status < 200 || answer.status >= 300) {
      const status = answer.status >= 400 && answer.status < 600 ? answer.status : 502;
      return Response.json({ code: upstreamCodeOf(answer.body) ?? `http.${status}` }, { status, headers: NO_STORE });
    }
    const list = parseControlRunList(answer.body, input.data.controlId);
    if (!list) throw new AdminSessionError('admin.upstream_invalid', 502);
    return Response.json({ ...list, readAt: new Date().toISOString() }, { headers: NO_STORE });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
