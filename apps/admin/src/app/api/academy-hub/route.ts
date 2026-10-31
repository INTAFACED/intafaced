import { readAdminJson } from '@/lib/admin-json';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { adminSessionErrorResponse } from '@/lib/founder-session';
import { moduleDisabledResponse } from '@/lib/modules';
import { changeHub, isHubOp, loadHub } from '@/lib/academy/hub-server';

/**
 * The Learn hub desk (AC-articles-01).
 *
 *   GET                                   the featured slot and the topics, up to the owner's list limit
 *   POST { op: 'clear', reason }          nothing is featured
 *   POST { op: 'item', itemSlug, reason } a curriculum article is featured, replacing whatever the slot held
 *   POST { op: 'topic', slug, name }      a topic; an Academy tab's address is refused (academy.slug_reserved)
 *
 * A lesson is featured from its own page (/api/academy-lessons, op 'feature'). Founder-only; svc-academy records the
 * founder from their own token.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;

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
  const disabled = moduleDisabledResponse('academy-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  return Response.json(await loadHub(session), { headers: NO_STORE });
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('academy-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  try {
    const body = await readAdminJson(request);
    if (!isHubOp(body.op)) return incomplete('Unknown action.');
    const answer = await changeHub(session, body.op, body);
    if ('why' in answer) return incomplete(answer.why);
    return Response.json(answer.reply, { status: answer.status, headers: NO_STORE });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
