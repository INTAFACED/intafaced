import { readAdminJson } from '@/lib/admin-json';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { adminSessionErrorResponse } from '@/lib/founder-session';
import { moduleDisabledResponse } from '@/lib/modules';
import { isLimitsDeskOp, NOT_LISTED } from '@/lib/quant-limits-ops/model';
import { actOnLimits, loadLimitsDesk } from '@/lib/quant-limits-ops/server';

/**
 * Plan quotas and sandbox limits on the quant desk (J-algo-dev-12, AL-limits-01 and AL-limits-02).
 *
 *   GET ?profile=<name>                                                  one plan's quota and sandbox limits as stored
 *   POST { op: 'set', profile, resource, limit, reason, idempotencyKey }   one quota limit; blank is "not set"
 *   POST { op: 'sandbox', profile, limit, value, reason, idempotencyKey }  one sandbox limit; blank is "not set"
 *   POST { op: 'assign', accountId, profile, reason, idempotencyKey }      puts an account on a plan
 *   POST { op: 'corpus', profile }                                         runs the escape corpus under a plan's limits
 *
 * The proxy names these four actions one by one (LIMITS_DESK_OPS); any other `op` is refused here and never reaches
 * svc-quant. svc-quant records the founder from their own token with the reason on every write. No money moves.
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;
const PROFILE = /^.{1,80}$/;

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
  const profile = new URL(request.url).searchParams.get('profile')?.trim() ?? '';
  if (!PROFILE.test(profile)) return incomplete('Which plan? Name it in at most 80 characters.');
  return Response.json(await loadLimitsDesk(session, profile), { headers: NO_STORE });
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('more-ops');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  try {
    const body = await readAdminJson(request);
    if (!isLimitsDeskOp(body.op)) return Response.json(NOT_LISTED, { status: 400, headers: NO_STORE });
    const answer = await actOnLimits(session, body.op, body);
    if ('why' in answer) return incomplete(answer.why);
    return Response.json(answer.reply, { status: answer.status, headers: NO_STORE });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
