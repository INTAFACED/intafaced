import {
  announcementActionSchema,
  announcementWindowProblem,
  ANNOUNCEMENT_BODY_MAX,
  ANNOUNCEMENT_KINDS,
  ANNOUNCEMENT_TITLE_MAX,
} from '@intafaced/contracts/ops-console-announcements';
import { readAdminJson } from '@/lib/admin-json';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { changeAnnouncement, loadAnnouncements, saveAnnouncement } from '@/lib/console-announcements/server';
import { adminSessionErrorResponse } from '@/lib/founder-session';

/**
 * The console's announcement banner (OPS-admin-access-08).
 *
 *   GET                                                                     the newest announcements and the one showing now
 *   POST { op: 'save', basis, kind, title, body, action, startsAt, endsAt, publish }   save a draft, or publish at once
 *   POST { op: 'publish' | 'withdraw', id }                                 publish a draft, or take one down
 *
 * Founder-only and always on (no module gate), like maintenance mode: the banner shows on every page. svc-ops records the
 * founder from their own token and holds the one-at-a-time rule. No money moves.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  return Response.json({ view: await loadAnnouncements(session), me: session.session.userId }, { headers: NO_STORE });
}

export async function POST(request: Request) {
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  try {
    const body = await readAdminJson(request);
    const send = ({ status, reply }: { status: number; reply: unknown }) => Response.json(reply, { status, headers: NO_STORE });
    switch (body.op) {
      case 'save': {
        const basis = body.basis === null || body.basis === undefined ? null : str(body.basis);
        if (basis !== null && !UUID.test(basis)) return incomplete('The basis is not an announcement id.');
        const kind = ANNOUNCEMENT_KINDS.find((k) => k === body.kind);
        if (!kind) return incomplete('Pick a kind: information, warning, error or success.');
        const title = str(body.title).trim();
        if (title === '' || title.length > ANNOUNCEMENT_TITLE_MAX)
          return incomplete(`Write a title of 1 to ${ANNOUNCEMENT_TITLE_MAX} characters.`);
        const text = str(body.body).trim();
        if (text.length > ANNOUNCEMENT_BODY_MAX) return incomplete(`Keep the message to ${ANNOUNCEMENT_BODY_MAX} characters.`);
        const action = announcementActionSchema.safeParse(body.action);
        if (!action.success) return incomplete('A link needs an https address or a console path and a label; a dialog needs its text.');
        const startsAt = str(body.startsAt);
        const endsAt = str(body.endsAt);
        const publish = body.publish === true;
        const problem = announcementWindowProblem(startsAt, endsAt, new Date().toISOString(), false);
        if (problem) return incomplete(problem);
        const content = {
          kind,
          title,
          body: text,
          action: action.data,
          startsAt: new Date(startsAt).toISOString(),
          endsAt: new Date(endsAt).toISOString(),
        };
        return send(await saveAnnouncement(session, basis, content, publish));
      }
      case 'publish':
      case 'withdraw':
        if (!UUID.test(str(body.id))) return incomplete('Which announcement?');
        return send(await changeAnnouncement(session, str(body.id), body.op));
      default:
        return incomplete('Unknown action.');
    }
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
