import { moduleDisabledResponse } from '@/lib/modules';
import {
  accountLimitResultSchema,
  accountLimitsHistoryInputSchema,
  accountLimitsLookupInputSchema,
  accountLimitsStateSchema,
} from '@intafaced/contracts';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { adminSessionErrorResponse, AdminSessionError, authorizeAdminRequest, founderEdgeCall } from '@/lib/founder-session';
import { limitsExecute } from '@/lib/accounts/limits-server';
import { handleStep } from '@/lib/desk/step-route';

/**
 * A customer's limit overrides (J-ops-console-04 #12).
 *
 * GET reads identity's overrides with the owner policy (`?id=`) or the override history (`?id=&history=true&limit=`). POST
 * runs one step of a two-founder raise above the owner ceiling: the first founder proposes at identity, the other founder
 * approves the same account, rail, asset, figures, end time, reason and override version, and identity spends the
 * approval once. A change at or under the ceiling, and ending an override, go to `/api/accounts/limits/override`.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('accounts');
  if (disabled) return disabled;
  try {
    const { session, config } = await authorizeAdminRequest(request);
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some((key) => !['id', 'history', 'limit'].includes(key)))
      throw new AdminSessionError('admin.accounts_input', 400);
    const userId = params.get('id')?.toLowerCase();
    const history = params.get('history') === 'true';
    const parsed = history
      ? accountLimitsHistoryInputSchema.safeParse({ userId, limit: Number(params.get('limit')) })
      : accountLimitsLookupInputSchema.safeParse({ userId });
    if (!parsed.success || (!history && params.size !== 1)) throw new AdminSessionError('admin.accounts_input', 400);
    const data = await founderEdgeCall(
      config,
      'identity',
      history ? 'accountControls.limitsHistory' : 'accountControls.limits',
      'GET',
      parsed.data,
      session.accessToken,
    );
    const valid = history
      ? Array.isArray(data) &&
        data.length <= Number(params.get('limit')) &&
        data.every((row) => {
          const one = accountLimitResultSchema.safeParse(row);
          return one.success && one.data.userId === parsed.data.userId;
        })
      : data === null ||
        (() => {
          const state = accountLimitsStateSchema.safeParse(data);
          return state.success && state.data.userId === parsed.data.userId;
        })();
    if (!valid) throw new AdminSessionError('admin.upstream_invalid', 502);
    return Response.json(data, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const disabled = moduleDisabledResponse('accounts');
  if (disabled) return disabled;
  const session = await adminBffSession(request);
  if (session instanceof Response) return session;
  return handleStep(request, session, {
    kinds: ['identity.account.limit_override'],
    check: () => null,
    execute: limitsExecute(session),
  });
}
