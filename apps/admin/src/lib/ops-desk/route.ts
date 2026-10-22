import 'server-only';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { readAdminJson } from '@/lib/admin-json';
import { explainRefusal } from '@/lib/desk/refusal-copy';
import { AdminSessionError, adminSessionErrorResponse } from '@/lib/founder-session';
import { handleStep, refusalResponse, stepResponse } from '@/lib/desk/step-route';
import { moduleDisabledResponse } from '@/lib/modules';
import { DESKS, readSpecFor } from './catalog';
import { readDirectRequest } from './direct-model';
import { runDirect } from './direct';
import { opsExecute } from './execute';
import { loadCustomerBalances, loadCustomerEntries, loadDesk, loadPage, loadTransferDetail } from './server';
import { transferIdOf } from './transfer-id';
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
  // `?section=<id>` (repeatable) reads only those sections; an id the desk does not have reads nothing.
  const sections = new URL(request.url).searchParams.getAll('section');
  return Response.json(await loadDesk(session, deskId, new Date(), sections.length > 0 ? sections : undefined), { headers: NO_STORE });
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

/** The page marker svc-bank issues is base64url; nothing else is passed on. */
const PAGE_CURSOR = /^[A-Za-z0-9_-]{1,512}$/;

/**
 * GET one transfer's full record (svc-bank `ops.transferDetail`) as the signed-in founder. Every record handed out writes an audit
 * line naming the founder, so the request must come from this console's own page: a browser that says the request is not same-origin
 * (another site, or a sibling subdomain) is refused before anything is read. The id is checked here only for shape; the service
 * judges the rest, and gives an unknown id and a malformed one the same answer.
 */
export async function payTransferGet(request: Request): Promise<Response> {
  const disabled = moduleDisabledResponse(DESKS.pay.module);
  if (disabled) return disabled;
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') return Response.json({ error: 'not_same_origin' }, { status: 403, headers: NO_STORE });
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  const id = transferIdOf(new URL(request.url).searchParams.get('id'));
  if (id === null) return Response.json({ error: 'transfer_id_invalid' }, { status: 400, headers: NO_STORE });
  return Response.json(await loadTransferDetail(session, id), { headers: NO_STORE });
}

/** GET the next page of a Personal Pay list that has a page marker (`?read=<read id>&cursor=<marker>`), as the signed-in founder. */
export async function payPageGet(request: Request): Promise<Response> {
  const disabled = moduleDisabledResponse(DESKS.pay.module);
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  const params = new URL(request.url).searchParams;
  const cursor = params.get('cursor') ?? '';
  const readId = params.get('read') ?? '';
  const spec = readSpecFor('pay', readId);
  if (!PAGE_CURSOR.test(cursor) || spec === undefined || spec.cursorKey === undefined) {
    return Response.json({ error: 'page_invalid' }, { status: 400, headers: NO_STORE });
  }
  const outcome = await loadPage(session, 'pay', readId, cursor);
  return Response.json(outcome, { headers: NO_STORE });
}

const CUSTOMER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COIN_ID = /^[A-Za-z0-9._-]{1,16}$/;
const ENTRIES_CURSOR = /^[A-Za-z0-9_-]{1,16}$/;

/**
 * GET one customer's balances for the finance-treasury desk (svc-bank `ops.customerBalances`, admin:treasury), or with `asset` the
 * entries behind that coin's balance (`ops.customerBalanceEntries`, with `cursor` for a later page). svc-bank writes a log line
 * naming the operator and the customer before it reads a figure, so the request must come from this console's own page: a browser
 * that says it is not same-origin is refused before anything is read. The ids are checked here only for shape; the service judges
 * the rest. Who may read is the treasury permission on the founder's own session, decided where permissions are granted.
 */
export async function bankCustomerGet(request: Request): Promise<Response> {
  const disabled = moduleDisabledResponse(DESKS.bank.module);
  if (disabled) return disabled;
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') return Response.json({ error: 'not_same_origin' }, { status: 403, headers: NO_STORE });
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  const params = new URL(request.url).searchParams;
  const user = params.get('user')?.trim() ?? '';
  const asset = params.get('asset');
  const cursor = params.get('cursor');
  if (
    !CUSTOMER_ID.test(user) ||
    (asset !== null && !COIN_ID.test(asset)) ||
    (cursor !== null && (asset === null || !ENTRIES_CURSOR.test(cursor)))
  ) {
    return Response.json({ error: 'customer_request_invalid' }, { status: 400, headers: NO_STORE });
  }
  if (asset === null) return Response.json(await loadCustomerBalances(session, user), { headers: NO_STORE });
  return Response.json(await loadCustomerEntries(session, user, asset, cursor), { headers: NO_STORE });
}
