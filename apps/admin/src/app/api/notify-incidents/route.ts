import { readAdminJson } from '@/lib/admin-json';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { adminSessionErrorResponse } from '@/lib/founder-session';
import { moduleDisabledResponse } from '@/lib/modules';
import { IMPACTS, checkIncidentDraft, type Impact } from '@/lib/notify/incidents-model';
import {
  approvePublish,
  defineTemplate,
  draftIncident,
  loadIncidentDesk,
  publishIncident,
  requestPublish,
  retireTemplate,
} from '@/lib/notify/incidents-server';

/**
 * The incident desk.
 *
 *   GET                                                   incidents (drafts too), templates, components, publish approvals
 *   POST { op: 'draft', basis, title, body, impact, components, parentId, resolves }   a draft incident or update
 *   POST { op: 'request', noticeId }                      ask identity for the approval this draft's publish spends
 *   POST { op: 'approve', noticeId, approvalId }          a second founder approves the draft as svc-notify holds it now
 *   POST { op: 'publish', noticeId, approvalId, operationId }   svc-notify spends the approval once
 *   POST { op: 'define-template', ...template } / { op: 'retire-template', id }
 *
 * Founder-only. Each service records the founder from their own token. No money moves.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const COMPONENT = /^[a-z][a-z0-9-]{1,39}$/;

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
const impactOf = (v: unknown): Impact | null | undefined =>
  v === null || v === undefined || v === '' ? null : (IMPACTS as readonly unknown[]).includes(v) ? (v as Impact) : undefined;
const componentsOf = (v: unknown): string[] | null =>
  v === undefined || v === null
    ? []
    : Array.isArray(v) && v.length <= 100 && v.every((c) => typeof c === 'string' && COMPONENT.test(c))
      ? (v as string[])
      : null;

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('notify');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  return Response.json(await loadIncidentDesk(session), { headers: NO_STORE });
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
        const impact = impactOf(body.impact);
        const components = componentsOf(body.components);
        const parentId = body.parentId === null || body.parentId === undefined ? null : str(body.parentId);
        const basis = body.basis === null || body.basis === undefined ? null : str(body.basis);
        if (
          impact === undefined ||
          components === null ||
          (parentId !== null && !UUID.test(parentId)) ||
          (basis !== null && !UUID.test(basis))
        )
          return incomplete('The impact, components or incident are not in the shape svc-notify takes.');
        const input = {
          basis,
          title: str(body.title),
          body: str(body.body),
          impact,
          components,
          parentId,
          resolves: body.resolves === true,
        };
        const check = checkIncidentDraft(input);
        if (!check.ok) return incomplete(check.why);
        return send(await draftIncident(session, input));
      }
      case 'request':
        if (!UUID.test(str(body.noticeId))) return incomplete('Which draft?');
        return send(await requestPublish(session, str(body.noticeId)));
      case 'approve':
        if (!UUID.test(str(body.noticeId)) || !ID.test(str(body.approvalId))) return incomplete('Which draft and which approval?');
        return send(await approvePublish(session, str(body.noticeId), str(body.approvalId)));
      case 'publish':
        if (!UUID.test(str(body.noticeId)) || !ID.test(str(body.approvalId)) || !ID.test(str(body.operationId)))
          return incomplete('Which draft and which approval?');
        return send(await publishIncident(session, str(body.noticeId), str(body.approvalId), str(body.operationId)));
      case 'define-template': {
        const impact = impactOf(body.impact);
        const components = componentsOf(body.components);
        if (impact === undefined || components === null)
          return incomplete('The impact or components are not in the shape svc-notify takes.');
        const group = str(body.group).trim();
        return send(
          await defineTemplate(session, {
            id: str(body.id).trim(),
            name: str(body.name),
            group: group === '' ? null : group,
            title: str(body.title),
            body: str(body.body),
            impact,
            components,
          }),
        );
      }
      case 'retire-template':
        if (!COMPONENT.test(str(body.id))) return incomplete('Which template?');
        return send(await retireTemplate(session, str(body.id)));
      default:
        return incomplete('Unknown action.');
    }
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
