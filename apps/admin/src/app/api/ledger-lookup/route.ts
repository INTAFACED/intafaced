import { moduleDisabledResponse } from '@/lib/modules';
import { adminSessionErrorResponse, AdminSessionError, authorizeAdminRequest, upstreamCodeOf } from '@/lib/founder-session';
import { lookupQuery, parseLookupAnswer } from '@/lib/ledger/lookup';

/**
 * The ledger object lookup (J-ops-console-03, OPS-rules-monitoring-12).
 *
 * GET `?txId=` reads one booked transaction; GET `?businessKey=` traces a business key to the transaction it booked. The
 * call goes to svc-edge's named lookup route with the signed-in founder's OWN token (never a deployment credential), so
 * svc-ledger records the lookup under the person before it reads (owner decision 2026-10-23: `admin:read` with a second
 * factor). svc-ledger's refusals come back with its own code; an answer that is not the shape asked for is refused.
 */

export const dynamic = 'force-dynamic';

const TIMEOUT_MS = 6_000;

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('ledger');
  if (disabled) return disabled;
  try {
    const { session, config } = await authorizeAdminRequest(request);
    const params = new URL(request.url).searchParams;
    const keys = [...params.keys()];
    if (keys.length !== 1 || (keys[0] !== 'txId' && keys[0] !== 'businessKey'))
      throw new AdminSessionError('admin.ledger_lookup_input', 400);
    const mode = keys[0];
    const query = lookupQuery(mode, params.get(mode) ?? '');
    if (!query) throw new AdminSessionError('admin.ledger_lookup_input', 400);
    const path =
      'txId' in query
        ? `/admin/ledger/transactions/${query.txId}`
        : `/admin/ledger/trace?businessKey=${encodeURIComponent(query.businessKey)}`;
    let upstream: Response;
    try {
      upstream = await fetch(`${config.edgeUrl}${path}`, {
        method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${session.accessToken}` },
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new AdminSessionError('admin.upstream_unavailable', 503);
    }
    const body: unknown = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      const status = upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502;
      return Response.json({ code: upstreamCodeOf(body) ?? `http.${status}` }, { status, headers: { 'cache-control': 'no-store' } });
    }
    const answer = parseLookupAnswer(query, body);
    if (!answer) throw new AdminSessionError('admin.upstream_invalid', 502);
    return Response.json(answer, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
