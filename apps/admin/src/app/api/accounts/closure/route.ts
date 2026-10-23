import { moduleDisabledResponse } from '@/lib/modules';
import {
  accountClosureHistoryInputSchema,
  accountClosureLookupInputSchema,
  accountClosureResultSchema,
  accountClosureStateSchema,
} from '@intafaced/contracts';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { adminSessionErrorResponse, AdminSessionError, authorizeAdminRequest, founderEdgeCall } from '@/lib/founder-session';
import { closureExecute } from '@/lib/accounts/closure';
import { handleStep } from '@/lib/desk/step-route';

/**
 * Staff close and reopen of one account (J-ops-console-04 #7).
 *
 * GET reads identity's closure state for an account (`?id=`), or its closure history (`?id=&history=true&limit=`).
 * POST runs one step of a two-founder request: the first founder proposes at identity, a different person approves the
 * same account, version, reason code and reason, and identity's closure spends the approval once.
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
      ? accountClosureHistoryInputSchema.safeParse({ userId, limit: Number(params.get('limit')) })
      : accountClosureLookupInputSchema.safeParse({ userId });
    if (!parsed.success) throw new AdminSessionError('admin.accounts_input', 400);
    const data = await founderEdgeCall(
      config,
      'identity',
      history ? 'accountControls.closureHistory' : 'accountControls.closureState',
      'GET',
      parsed.data,
      session.accessToken,
    );
    const valid = history
      ? Array.isArray(data) &&
        data.length <= Number(params.get('limit')) &&
        data.every((row) => {
          const parsedRow = accountClosureResultSchema.safeParse(row);
          return parsedRow.success && parsedRow.data.userId === parsed.data.userId;
        })
      : data === null ||
        (() => {
          const state = accountClosureStateSchema.safeParse(data);
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
    kinds: ['identity.account.close', 'identity.account.reopen'],
    check: () => null,
    execute: closureExecute(session),
  });
}
