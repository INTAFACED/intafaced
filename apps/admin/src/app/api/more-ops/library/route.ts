import { readAdminJson } from '@/lib/admin-json';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { adminSessionErrorResponse } from '@/lib/founder-session';
import { moduleDisabledResponse } from '@/lib/modules';
import { isLibraryDeskOp, NOT_LISTED } from '@/lib/quant-library-ops/model';
import { actOnLibrary, loadLibraryDesk } from '@/lib/quant-library-ops/server';

/**
 * The strategy library desk on the market desk (J-algo-dev-10, AL-library-03).
 *
 *   GET ?cursor=<seq>                                          the review queue, oldest first, a page of the owner's size
 *   POST { op: 'hide' | 'unhide' | 'remove', listingId, reason, seq }
 *   POST { op: 'dispute-open', listingId, reason, ticketRef, seq }
 *   POST { op: 'dispute-resolve', disputeId, reason }
 *
 * The proxy names these five actions one by one (LIBRARY_DESK_OPS); any other `op` is refused here and never reaches
 * svc-quant. svc-quant records the founder from their own token with the reason on every action. No money moves.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;
const CURSOR = /^\d{1,18}$/;

const incomplete = (body: string) =>
  Response.json(
    {
      ok: false,
      title: 'That request is not complete',
      body,
      next: 'Nothing was changed. Correct it and try again.',
      code: null,
      changed: 'no',
    },
    { status: 400, headers: NO_STORE },
  );

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('more-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  const cursor = new URL(request.url).searchParams.get('cursor');
  if (cursor !== null && !CURSOR.test(cursor)) return incomplete('That page marker is not one this desk gave.');
  return Response.json(await loadLibraryDesk(session, cursor), { headers: NO_STORE });
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('more-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  try {
    const body = await readAdminJson(request);
    if (!isLibraryDeskOp(body.op)) return Response.json(NOT_LISTED, { status: 400, headers: NO_STORE });
    const answer = await actOnLibrary(session, body.op, body);
    if ('why' in answer) return incomplete(answer.why);
    return Response.json(answer.reply, { status: answer.status, headers: NO_STORE });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
