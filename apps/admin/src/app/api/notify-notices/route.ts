import { readAdminJson } from '@/lib/admin-json';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { adminSessionErrorResponse } from '@/lib/founder-session';
import { moduleDisabledResponse } from '@/lib/modules';
import { approvePublish, publishIncident, requestPublish } from '@/lib/notify/incidents-server';
import { CATEGORY_ID, checkAnnouncementDraft, parseCategories } from '@/lib/notify/notices-model';
import { draftAnnouncement, loadNoticesDesk, setCategories } from '@/lib/notify/notices-server';

/**
 * The announcement desk.
 *
 *   GET                                                   announcements (drafts too) with their category; the category list; approvals
 *   POST { op: 'draft', basis, title, body, category }    a draft announcement, filed under a category or none
 *   POST { op: 'request' | 'approve' | 'publish', noticeId, ... }   the four-eyes publish, as on the incident desk
 *   POST { op: 'categories', categories, expectedRevision, reason }   the whole category list as "id: Name" lines; blank clears it
 *
 * Founder-only. svc-notify records the founder from their own token. No money moves.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

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

const str = (v: unknown) => (typeof v === 'string' ? v : '');

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('notify');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  return Response.json(await loadNoticesDesk(session), { headers: NO_STORE });
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('notify');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  try {
    const body = await readAdminJson(request);
    const send = ({ status, reply }: { status: number; reply: unknown }) => Response.json(reply, { status, headers: NO_STORE });
    switch (body.op) {
      case 'draft': {
        const basis = body.basis === null || body.basis === undefined ? null : str(body.basis);
        const category = body.category === null || body.category === undefined || body.category === '' ? null : str(body.category);
        if (basis !== null && !UUID.test(basis)) return incomplete('The basis is not a notice id.');
        if (category !== null && !CATEGORY_ID.test(category)) return incomplete('The category is not one svc-notify takes.');
        const input = { title: str(body.title), body: str(body.body), category };
        const check = checkAnnouncementDraft(input);
        if (!check.ok) return incomplete(check.why);
        return send(await draftAnnouncement(session, { ...input, basis }));
      }
      case 'request':
        if (!UUID.test(str(body.noticeId))) return incomplete('Which draft?');
        return send(await requestPublish(session, { kind: 'notice', id: str(body.noticeId) }));
      case 'approve':
        if (!UUID.test(str(body.noticeId)) || !ID.test(str(body.approvalId))) return incomplete('Which draft and which approval?');
        return send(await approvePublish(session, { kind: 'notice', id: str(body.noticeId) }, str(body.approvalId)));
      case 'publish':
        if (!UUID.test(str(body.noticeId)) || !ID.test(str(body.approvalId)) || !ID.test(str(body.operationId)))
          return incomplete('Which draft and which approval?');
        return send(await publishIncident(session, str(body.noticeId), str(body.approvalId), str(body.operationId)));
      case 'categories': {
        const parsed = parseCategories(str(body.categories));
        if (!parsed.ok) return incomplete(parsed.why);
        const reason = str(body.reason).trim();
        if (reason === '' || reason.length > 500) return incomplete('Say why, in 1 to 500 characters.');
        if (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 0)
          return incomplete('Which revision did you read?');
        return send(await setCategories(session, { list: parsed.list, expectedRevision: body.expectedRevision as number, reason }));
      }
      default:
        return incomplete('Unknown action.');
    }
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
