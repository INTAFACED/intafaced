import 'server-only';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { readAdminJson } from '@/lib/admin-json';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import { AdminSessionError, adminSessionErrorResponse } from '@/lib/founder-session';
import { handleStep, refusalResponse, stepResponse } from '@/lib/desk/step-route';
import { moduleDisabledResponse } from '@/lib/modules';
import { DESKS } from './catalog';
import { readDirectRequest } from './direct-model';
import { runDirect } from './direct';
import { opsExecute } from './execute';
import { loadDesk, loadTransferDetail } from './server';
import type { OpsDeskId } from './types';

/**
 * The shared body of the four module-desk BFFs. Each route file only names its desk (and, if it has actions, the
 * request kinds it accepts), so the gate, the session, the read and the two-founder steps are written once.
 *
 * GET reads the desk as the signed-in founder. POST (only where a desk has actions) runs one step of a two-founder
 * request, exactly as `/api/kill-switch` does. A desk with no actions has no POST at all: it cannot change anything.
 */

const NO_STORE = { 'cache-control': 'no-store' } as const;

export async function deskGet(request: Request, deskId: OpsDeskId): Promise<Response> {
  const disabled = moduleDisabledResponse(DESKS[deskId].module);
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  return Response.json(await loadDesk(session, deskId), { headers: NO_STORE });
}

export async function deskPost(request: Request, deskId: OpsDeskId, kinds: readonly string[]): Promise<Response> {
  const disabled = moduleDisabledResponse(DESKS[deskId].module);
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  return handleStep(request, session, { kinds, check: () => null, execute: opsExecute(session) });
}

/**
 * POST for an action one operator takes and the service asks no second person for (a moderator escalating a P2P dispute). The
 * reply has the same shape as the last step of a two-founder request, so the browser reads both the same way.
 */
export async function deskDirectPost(request: Request, deskId: OpsDeskId): Promise<Response> {
  const disabled = moduleDisabledResponse(DESKS[deskId].module);
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  let raw: Record<string, unknown>;
  try {
    raw = await readAdminJson(request);
  } catch (error) {
    return adminSessionErrorResponse(error instanceof AdminSessionError ? error : new AdminSessionError('admin.json_required', 400));
  }
  const body = readDirectRequest(raw);
  if (body === null) return refusalResponse('execute', explainRefusal('admin.request_invalid', 400, false), 400);
  const reply = await runDirect(session, body);
  console.warn(
    JSON.stringify({
      audit: 'admin.desk.direct',
      at: new Date().toISOString(),
      founder: session.session.userId,
      action: body.action,
      target: body.disputeId,
      ok: reply.ok,
      code: reply.ok ? null : reply.refusal.code,
      changed: reply.ok ? 'yes' : reply.refusal.changed,
    }),
  );
  return stepResponse(
    reply.ok ? { ok: true, step: 'execute', detail: reply.detail } : { ok: false, step: 'execute', refusal: reply.refusal },
  );
}

/** A transfer id as svc-bank issues one: a UUID for a standing-order execution, a client-chosen printable token for a one-off send. */
export const TRANSFER_ID = /^[\x21-\x7e]{1,64}$/;

/**
 * GET one transfer's full record (svc-bank `ops.transferDetail`) as the signed-in founder. The id comes from the query string, is
 * checked here only so a request line cannot carry anything but a short printable token, and is otherwise the service's to judge:
 * an unknown id and a malformed one get the same answer from it.
 */
export async function payTransferGet(request: Request): Promise<Response> {
  const disabled = moduleDisabledResponse(DESKS.pay.module);
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  const id = new URL(request.url).searchParams.get('id')?.trim() ?? '';
  if (!TRANSFER_ID.test(id)) return Response.json({ error: 'transfer_id_invalid' }, { status: 400, headers: NO_STORE });
  return Response.json(await loadTransferDetail(session, id), { headers: NO_STORE });
}
