import { adminBffSession } from '@/lib/admin-bff-gate';
import { moduleDisabledResponse } from '@/lib/modules';
import { isTicketId } from '@/lib/support/model';
import { loadTicketFiles } from '@/lib/support/files-server';

/** The files on one ticket with their scan state (SP-tickets-02). Read as the signed-in founder; the store key never leaves svc-support. */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('support');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  const id = new URL(request.url).searchParams.get('id');
  if (!isTicketId(id)) return Response.json({ code: 'admin.support_ticket_id' }, { status: 400, headers: NO_STORE });
  return Response.json(await loadTicketFiles(session, id), { headers: NO_STORE });
}
