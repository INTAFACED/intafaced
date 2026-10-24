import { accountLimitResultSchema } from '@intafaced/contracts';
import { moduleDisabledResponse } from '@/lib/modules';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { readAdminJson } from '@/lib/admin-json';
import { adminSessionErrorResponse, AdminSessionError } from '@/lib/founder-session';
import { founderCall, parseWith } from '@/lib/desk/founder-call';
import { readLimitClearForm, readLimitSetForm } from '@/lib/accounts/limits-forms';
import { limitsAnswer } from '@/lib/accounts/limits-server';

/**
 * One founder's change to a customer's limit override (J-ops-console-04 #12): `{ action: 'set', ... }` sets one at or under
 * the owner ceiling, `{ action: 'clear', ... }` ends one now. Identity refuses a set above the ceiling here
 * (`identity.limit_requires_approver`); that one goes through the two-founder request on `/api/accounts/limits`.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('accounts');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  let raw: Record<string, unknown>;
  try {
    raw = await readAdminJson(request);
  } catch (error) {
    return adminSessionErrorResponse(error instanceof AdminSessionError ? error : new AdminSessionError('admin.json_required', 400));
  }
  const { action, ...form } = raw;
  const founderId = session.session.userId;
  const set = action === 'set' ? readLimitSetForm(form, founderId) : null;
  const clear = action === 'clear' ? readLimitClearForm(form, founderId) : null;
  if (!set && !clear)
    return Response.json(
      {
        ok: false,
        text: 'That change was not accepted: check the asset, at least one figure above zero, the end time and a reason of 12 to 255 characters. Nothing was sent.',
      },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  const result = set
    ? await founderCall(session, 'identity', 'accountControls.limitsSet', 'POST', set, parseWith(accountLimitResultSchema))
    : await founderCall(session, 'identity', 'accountControls.limitsClear', 'POST', clear!, parseWith(accountLimitResultSchema));
  return limitsAnswer(result, (set ?? clear)!.userId);
}
