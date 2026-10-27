import { moduleDisabledResponse } from '@/lib/modules';
import { adminSessionErrorResponse, AdminSessionError, authorizeAdminRequest } from '@/lib/founder-session';
import { isAccountId } from '@/lib/ledger/account-metadata';
import { readAccountMetadataAsFounder } from '@/lib/ledger/account-metadata-server';
import { treasuryParked } from '@/lib/ledger/reconciliation-server';

/**
 * One ledger account's operator metadata (J-ops-console-03 #6, #7, OPS-ledger-desk-01).
 *
 * GET `?accountId=` answers the keys that hold a value, the deleted keys with their revision, the newest changes with the
 * value before and after, and whether the posting freeze is on. It goes to svc-edge with the signed-in founder's OWN
 * token, so svc-ledger records the read under the person first; it answers while the book is frozen. The writes are
 * `/api/ledger-metadata/set` (one founder) and `/api/ledger-metadata/delete` (two founders).
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('ledger');
  if (disabled) return disabled;
  try {
    const founder = await authorizeAdminRequest(request);
    const ids = new URL(request.url).searchParams.getAll('accountId');
    if (ids.length !== 1 || !isAccountId(ids[0])) throw new AdminSessionError('admin.ledger_desk_input', 400);
    const outcome = await readAccountMetadataAsFounder(founder, ids[0]);
    if (!outcome.ok) return Response.json({ code: outcome.code }, { status: outcome.status, headers: NO_STORE });
    return Response.json({ metadata: outcome.metadata, treasuryParked: treasuryParked() }, { headers: NO_STORE });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
