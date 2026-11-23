import { moduleDisabledResponse } from '@/lib/modules';
import {
  accountTierHistoryInputSchema,
  accountTierListSchema,
  accountTierLookupInputSchema,
  accountTierResultSchema,
  accountTierStateSchema,
} from '@intafaced/contracts';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { adminSessionErrorResponse, AdminSessionError, authorizeAdminRequest, founderEdgeRecordCall } from '@/lib/founder-session';
import { tierExecute } from '@/lib/accounts/tier';
import { handleStep } from '@/lib/desk/step-route';
import {
  IDENTITY_ACCOUNT_CONTROLS_TIERS,
  IDENTITY_ACCOUNT_CONTROLS_TIER_STATE,
  IDENTITY_ACCOUNT_CONTROLS_TIER_HISTORY,
} from '@intafaced/contracts/identity-account-controls-procedures';

/**
 * Account product tiers (J-ops-console-04 #11).
 *
 * GET reads the tiers on offer (`?list=true`), an account's tier (`?id=`), or its tier history (`?id=&history=true&limit=`).
 * POST runs one step of a two-founder request: the first founder proposes at identity, the other founder approves the
 * same account, tier, reason and tier version, and identity's tier move spends the approval once.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('accounts');
  if (disabled) return disabled;
  try {
    const { session, config } = await authorizeAdminRequest(request);
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some((key) => !['id', 'history', 'limit', 'list'].includes(key)))
      throw new AdminSessionError('admin.accounts_input', 400);
    if (params.get('list') === 'true') {
      if (params.size !== 1) throw new AdminSessionError('admin.accounts_input', 400);
      const data = await founderEdgeRecordCall(config, IDENTITY_ACCOUNT_CONTROLS_TIERS, {}, session.accessToken);
      if (!accountTierListSchema.safeParse(data).success) throw new AdminSessionError('admin.upstream_invalid', 502);
      return Response.json(data, { headers: { 'cache-control': 'no-store' } });
    }
    const userId = params.get('id')?.toLowerCase();
    if (params.get('history') === 'true') {
      const parsed = accountTierHistoryInputSchema.safeParse({ userId, limit: Number(params.get('limit')) });
      if (!parsed.success) throw new AdminSessionError('admin.accounts_input', 400);
      const data = await founderEdgeRecordCall(config, IDENTITY_ACCOUNT_CONTROLS_TIER_HISTORY, parsed.data, session.accessToken);
      const valid =
        Array.isArray(data) &&
        data.length <= Number(params.get('limit')) &&
        data.every((row) => {
          const parsedRow = accountTierResultSchema.safeParse(row);
          return parsedRow.success && parsedRow.data.userId === parsed.data.userId;
        });
      if (!valid) throw new AdminSessionError('admin.upstream_invalid', 502);
      return Response.json(data, { headers: { 'cache-control': 'no-store' } });
    }
    const parsed = accountTierLookupInputSchema.safeParse({ userId });
    if (!parsed.success) throw new AdminSessionError('admin.accounts_input', 400);
    const data = await founderEdgeRecordCall(config, IDENTITY_ACCOUNT_CONTROLS_TIER_STATE, parsed.data, session.accessToken);
    const valid =
      data === null ||
      (() => {
        const state = accountTierStateSchema.safeParse(data);
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
    kinds: ['identity.account.tier_move'],
    check: () => null,
    execute: tierExecute(session),
  });
}
