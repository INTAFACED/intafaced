import { readAdminJson } from '@/lib/admin-json';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { adminSessionErrorResponse } from '@/lib/founder-session';
import { moduleDisabledResponse } from '@/lib/modules';
import { changeEnrolment, loadEnrolment, loadMail, loadReports } from '@/lib/academy/enrolment-server';

/**
 * Staff enrolment, invitations, course email and learner exports (J-academy-15).
 *
 *   GET ?view=enrolment | mail[&id=<email>] | reports   what the page shows, as svc-academy answers it now
 *   POST { op, ... }   one change: bulkEnrol, staffEnrol, invite, bulkTag, sendMail, requestExport. Addresses and handles
 *                      are resolved through identity's exact lookup; svc-academy refuses a blank reason by name.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('academy-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  const params = new URL(request.url).searchParams;
  const view = params.get('view');
  const id = params.get('id');
  if (view === 'mail') return Response.json(await loadMail(session, id && UUID.test(id) ? id : null), { headers: NO_STORE });
  if (view === 'reports') return Response.json(await loadReports(session), { headers: NO_STORE });
  return Response.json(await loadEnrolment(session), { headers: NO_STORE });
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('academy-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  try {
    const body = await readAdminJson(request);
    const answer = await changeEnrolment(session, body);
    return Response.json(answer.reply, { status: answer.status, headers: NO_STORE });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
