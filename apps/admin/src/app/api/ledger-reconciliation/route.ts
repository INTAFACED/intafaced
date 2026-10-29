import { moduleDisabledResponse } from '@/lib/modules';
import { readAdminJson } from '@/lib/admin-json';
import { adminSessionErrorResponse, AdminSessionError, authorizeAdminRequest, upstreamCodeOf } from '@/lib/founder-session';
import { parseControlList, parseControlView } from '@/lib/ledger/reconciliation';
import { listControlsAsFounder, sendTreasuryControl, treasuryParked } from '@/lib/ledger/reconciliation-server';
import { defineReconciliationControlInputSchema, updateReconciliationControlInputSchema } from '@intafaced/contracts/ledger-reconciliation';

/**
 * Reconciliation controls (J-ops-console-07 steps 1-2, OPS-reconciliation-01).
 *
 * GET lists svc-ledger's controls as the signed-in founder, through svc-edge, and stamps when it read them. POST defines or
 * changes one control on the treasury transport: `{ action: 'define', body }` or `{ action: 'update', body }`, where `body` is
 * the contract's input. svc-ledger's refusals come back with its own code; a 2xx that is not a control is not reported as one.
 * Running a control is a two-founder request and lives at `/api/ledger-reconciliation/run`; so is pausing, resuming or
 * retiring one, at `/api/ledger-reconciliation/lifecycle`.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('ledger');
  if (disabled) return disabled;
  try {
    const { session, config } = await authorizeAdminRequest(request);
    const answer = await listControlsAsFounder(session, config);
    if (!answer) throw new AdminSessionError('admin.upstream_unavailable', 503);
    if (answer.status < 200 || answer.status >= 300) {
      const status = answer.status >= 400 && answer.status < 600 ? answer.status : 502;
      return Response.json({ code: upstreamCodeOf(answer.body) ?? `http.${status}` }, { status, headers: NO_STORE });
    }
    const controls = parseControlList(answer.body);
    if (!controls) throw new AdminSessionError('admin.upstream_invalid', 502);
    return Response.json({ controls, readAt: new Date().toISOString(), treasuryParked: treasuryParked() }, { headers: NO_STORE });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('ledger');
  if (disabled) return disabled;
  try {
    await authorizeAdminRequest(request);
    const raw = await readAdminJson(request);
    if (Object.keys(raw).sort().join(',') !== 'action,body' || (raw.action !== 'define' && raw.action !== 'update'))
      throw new AdminSessionError('admin.request_invalid', 400);
    const schema = raw.action === 'define' ? defineReconciliationControlInputSchema : updateReconciliationControlInputSchema;
    const parsed = schema.safeParse(raw.body);
    if (!parsed.success) throw new AdminSessionError('admin.request_invalid', 400, 'edge.invalid_reconciliation_control');
    // Pause, resume and retire are two-founder and go through `/api/ledger-reconciliation/lifecycle`, never this one-founder door.
    if ('lifecycle' in parsed.data && parsed.data.lifecycle !== undefined) throw new AdminSessionError('admin.request_invalid', 400);
    const parked = treasuryParked();
    if (parked) return Response.json({ code: 'admin.ledger_unconfigured', detail: parked }, { status: 503, headers: NO_STORE });
    const answer = await sendTreasuryControl(raw.action, parsed.data);
    if (!answer.reached) {
      return answer.sent
        ? Response.json({ code: 'admin.upstream_unavailable', changed: 'unknown' }, { status: 502, headers: NO_STORE })
        : Response.json({ code: 'admin.ledger_unconfigured', detail: answer.detail }, { status: 503, headers: NO_STORE });
    }
    if (answer.status < 200 || answer.status >= 300) {
      const status = answer.status >= 400 && answer.status < 600 ? answer.status : 502;
      return Response.json({ code: upstreamCodeOf(answer.body) ?? `http.${status}` }, { status, headers: NO_STORE });
    }
    const control = parseControlView(answer.body);
    if (!control) return Response.json({ code: 'admin.upstream_invalid', changed: 'unknown' }, { status: 502, headers: NO_STORE });
    return Response.json({ control }, { headers: NO_STORE });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
