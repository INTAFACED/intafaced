import { moduleDisabledResponse } from '@/lib/modules';
import { readAdminJson } from '@/lib/admin-json';
import { adminSessionErrorResponse, AdminSessionError, authorizeAdminRequest, upstreamCodeOf } from '@/lib/founder-session';
import { isAccountId, metadataSetBody, parseMetadataWrite } from '@/lib/ledger/account-metadata';
import { postTreasury, treasuryParked } from '@/lib/ledger/reconciliation-server';

/**
 * Set or overwrite one metadata key on a ledger account (J-ops-console-03 #6). One founder's write, on the treasury
 * transport like a reconciliation control: `{ accountId, body: { key, value, reason, revision } }`, where `revision` is
 * the key's revision the founder read (0 for a new key). svc-ledger answers a retry of the same set with its first change
 * and refuses `ledger.account_metadata_stale` when someone else wrote first, or `ledger.frozen` under the posting freeze.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('ledger');
  if (disabled) return disabled;
  try {
    await authorizeAdminRequest(request);
    const raw = await readAdminJson(request);
    if (Object.keys(raw).sort().join(',') !== 'accountId,body' || !isAccountId(raw.accountId))
      throw new AdminSessionError('admin.request_invalid', 400);
    const body = metadataSetBody(raw.body);
    if (!body) throw new AdminSessionError('admin.request_invalid', 400, 'ledger.account_metadata_invalid');
    const parked = treasuryParked();
    if (parked) return Response.json({ code: 'admin.ledger_unconfigured', detail: parked }, { status: 503, headers: NO_STORE });
    const answer = await postTreasury(`/admin/ledger/accounts/${raw.accountId}/metadata/set`, body);
    if (!answer.reached) {
      return answer.sent
        ? Response.json({ code: 'admin.upstream_unavailable', changed: 'unknown' }, { status: 502, headers: NO_STORE })
        : Response.json({ code: 'admin.ledger_unconfigured', detail: answer.detail }, { status: 503, headers: NO_STORE });
    }
    if (answer.status < 200 || answer.status >= 300) {
      const status = answer.status >= 400 && answer.status < 600 ? answer.status : 502;
      return Response.json({ code: upstreamCodeOf(answer.body) ?? `http.${status}` }, { status, headers: NO_STORE });
    }
    const change = parseMetadataWrite(answer.body, raw.accountId);
    if (!change || change.action !== 'set' || change.key !== body.key)
      return Response.json({ code: 'admin.upstream_invalid', changed: 'unknown' }, { status: 502, headers: NO_STORE });
    return Response.json({ change }, { headers: NO_STORE });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
