import { moduleDisabledResponse } from '@/lib/modules';
import { adminSessionErrorResponse, AdminSessionError, authorizeAdminRequest } from '@/lib/founder-session';
import { lookupQuery } from '@/lib/ledger/lookup';
import { readLedgerLookup } from '@/lib/ledger/lookup-server';

/**
 * The ledger object lookup (J-ops-console-03, OPS-rules-monitoring-12).
 *
 * GET `?txId=` reads one booked transaction; GET `?businessKey=` traces a business key to the transaction it booked. The
 * call goes to svc-edge's named lookup route with the signed-in founder's OWN token (never a deployment credential), so
 * svc-ledger records the lookup under the person before it reads (owner decision 2026-10-23: `admin:read` with a second
 * factor). svc-ledger's refusals come back with its own code; an answer that is not the shape asked for is refused.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('ledger');
  if (disabled) return disabled;
  try {
    const founder = await authorizeAdminRequest(request);
    const params = new URL(request.url).searchParams;
    const keys = [...params.keys()];
    if (keys.length !== 1 || (keys[0] !== 'txId' && keys[0] !== 'businessKey'))
      throw new AdminSessionError('admin.ledger_lookup_input', 400);
    const mode = keys[0];
    const query = lookupQuery(mode, params.get(mode) ?? '');
    if (!query) throw new AdminSessionError('admin.ledger_lookup_input', 400);
    const outcome = await readLedgerLookup(founder, query);
    if (!outcome.ok) return Response.json({ code: outcome.code }, { status: outcome.status, headers: { 'cache-control': 'no-store' } });
    return Response.json(outcome.answer, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
