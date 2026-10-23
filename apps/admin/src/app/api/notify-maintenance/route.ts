import { readAdminJson } from '@/lib/admin-json';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { adminSessionErrorResponse } from '@/lib/founder-session';
import { moduleDisabledResponse } from '@/lib/modules';
import { approvePublish, publishIncident, requestPublish } from '@/lib/notify/incidents-server';
import { MAINTENANCE_TARGETS, checkMaintenanceDraft, parseOffsets, type MaintenanceTarget } from '@/lib/notify/maintenance-model';
import { draftMaintenance, loadMaintenanceDesk, moveMaintenance } from '@/lib/notify/maintenance-server';

/**
 * The maintenance desk.
 *
 *   GET                                                   windows (drafts too) with state, moves and reminders; components; approvals
 *   POST { op: 'draft', basis, title, body, startsAt, endsAt, components, reminderOffsets }   a draft window
 *   POST { op: 'request' | 'approve' | 'publish', noticeId, ... }   the four-eyes publish, as on the incident desk
 *   POST { op: 'move', id, to, reason }                   an operator's move: verifying, completed, cancelled (or a reopen)
 *
 * Founder-only. svc-notify records the founder from their own token. No money moves.
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
const instant = (v: unknown) => {
  const t = Date.parse(str(v));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('notify');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  return Response.json(await loadMaintenanceDesk(session), { headers: NO_STORE });
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
        const components = body.components ?? [];
        const offsets = Array.isArray(body.reminderOffsets)
          ? parseOffsets(body.reminderOffsets.map((o: unknown) => String(o)).join(','))
          : parseOffsets(str(body.reminderOffsets));
        const basis = body.basis === null || body.basis === undefined ? null : str(body.basis);
        const startsAt = instant(body.startsAt);
        const endsAt = instant(body.endsAt);
        if (
          !Array.isArray(components) ||
          components.length > 100 ||
          !components.every((c) => typeof c === 'string' && COMPONENT.test(c)) ||
          offsets === null ||
          (basis !== null && !UUID.test(basis)) ||
          startsAt === null ||
          endsAt === null
        )
          return incomplete('The window, components or reminder offsets are not in the shape svc-notify takes.');
        const input = {
          title: str(body.title),
          body: str(body.body),
          startsAt,
          endsAt,
          components: components as string[],
          reminderOffsets: offsets,
        };
        const check = checkMaintenanceDraft(input);
        if (!check.ok) return incomplete(check.why);
        return send(await draftMaintenance(session, { ...input, basis }));
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
      case 'move': {
        const to = str(body.to);
        const reason = str(body.reason).trim();
        if (!UUID.test(str(body.id)) || !(MAINTENANCE_TARGETS as readonly string[]).includes(to))
          return incomplete('Which window, and which state?');
        if (reason === '' || reason.length > 500) return incomplete('Say why, in 1 to 500 characters.');
        return send(await moveMaintenance(session, { id: str(body.id), to: to as MaintenanceTarget, reason }));
      }
      default:
        return incomplete('Unknown action.');
    }
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
