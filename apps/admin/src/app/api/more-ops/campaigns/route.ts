import { readAdminJson } from '@/lib/admin-json';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { adminSessionErrorResponse } from '@/lib/founder-session';
import { moduleDisabledResponse } from '@/lib/modules';
import {
  checkCreate,
  checkMove,
  checkUpdate,
  createCampaign,
  loadCampaignDetail,
  loadCampaignsDesk,
  moveCampaign,
  updateCampaign,
} from '@/lib/campaigns-ops/builder-server';

/**
 * The campaigns desk and builder (J-campaigns-16).
 *
 *   GET                         every campaign the operator list holds and the calendar
 *   GET ?id=<campaign id>       one campaign with the activation gate's answer for its stored revision
 *   POST { op: 'create', definition }                    a draft; the name is its business key
 *   POST { op: 'update', id, revision, definition }      a draft's whole definition, over the revision read
 *   POST { op: 'move', id, action, revision }            submit, approve (a second founder), activate, pause, resume, end, archive
 *
 * Founder-only. svc-campaigns records the founder from their own token and refuses an approval by whoever wrote or asked.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

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
  const id = new URL(request.url).searchParams.get('id');
  if (id !== null) {
    if (!ID.test(id)) return incomplete('Which campaign?');
    return Response.json(await loadCampaignDetail(session, id), { headers: NO_STORE });
  }
  return Response.json(await loadCampaignsDesk(session), { headers: NO_STORE });
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('more-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  try {
    const body = await readAdminJson(request);
    const send = ({ status, reply }: { status: number; reply: unknown }) => Response.json(reply, { status, headers: NO_STORE });
    switch (body.op) {
      case 'create': {
        const checked = checkCreate(body.definition);
        if (!checked.ok) return incomplete(checked.why);
        return send(await createCampaign(session, checked.input));
      }
      case 'update': {
        const checked = checkUpdate({ id: body.id, revision: body.revision, definition: body.definition });
        if (!checked.ok) return incomplete(checked.why);
        return send(await updateCampaign(session, checked.input));
      }
      case 'move': {
        const checked = checkMove({ id: body.id, action: body.action, revision: body.revision });
        if (!checked.ok) return incomplete(checked.why);
        return send(await moveCampaign(session, checked.input));
      }
      default:
        return incomplete('Unknown action.');
    }
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
