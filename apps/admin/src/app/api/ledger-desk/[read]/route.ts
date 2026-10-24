import { moduleDisabledResponse } from '@/lib/modules';
import { adminSessionErrorResponse, AdminSessionError, authorizeAdminRequest } from '@/lib/founder-session';
import { deskQuery, LEDGER_DESK_READS, type LedgerDeskRead } from '@/lib/ledger/desk';
import { readLedgerDesk } from '@/lib/ledger/desk-server';

/**
 * The ledger desk's browsing reads (J-ops-console-03 #1, #4, #5, OPS-ledger-desk-01).
 *
 * GET `transactions?assetId=&from=&to=&before=` lists booked transactions, newest first, with svc-ledger's own total and a
 * cursor; GET `accounts?prefix=&after=` finds accounts by address prefix with their volumes; GET `stats` answers the
 * book's counts. The call goes to svc-edge's named route with the signed-in founder's OWN token, so svc-ledger records a
 * page of the list or the search under the person before it reads. svc-ledger's refusals come back with its own code;
 * an answer that is not the shape asked for is refused.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ read: string }> }) {
  const disabled = moduleDisabledResponse('ledger');
  if (disabled) return disabled;
  try {
    const founder = await authorizeAdminRequest(request);
    const { read } = await params;
    if (!(LEDGER_DESK_READS as readonly string[]).includes(read)) throw new AdminSessionError('admin.ledger_desk_input', 404);
    const searchParams = new URL(request.url).searchParams;
    const given: Record<string, string> = {};
    for (const key of new Set(searchParams.keys())) {
      const values = searchParams.getAll(key);
      if (values.length !== 1) throw new AdminSessionError('admin.ledger_desk_input', 400);
      given[key] = values[0]!;
    }
    const query = deskQuery(read as LedgerDeskRead, given);
    if (!query) throw new AdminSessionError('admin.ledger_desk_input', 400);
    const outcome = await readLedgerDesk(founder, read as LedgerDeskRead, query);
    if (!outcome.ok) return Response.json({ code: outcome.code }, { status: outcome.status, headers: { 'cache-control': 'no-store' } });
    return Response.json(outcome.answer, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
