import { moduleDisabledResponse } from '@/lib/modules';
import {
  accountArchiveHistoryInputSchema,
  accountArchiveLookupInputSchema,
  accountArchiveProposalsSchema,
  accountArchiveResultSchema,
  accountArchiveStateSchema,
} from '@intafaced/contracts';
import { adminBffSession } from '@/lib/admin-bff-gate';
import { adminSessionErrorResponse, AdminSessionError, authorizeAdminRequest, founderEdgeCall } from '@/lib/founder-session';
import { archiveExecute } from '@/lib/accounts/archive';
import { handleStep } from '@/lib/desk/step-route';

/**
 * Archive of one closed customer record (J-ops-console-04 #10).
 *
 * GET reads identity's archive state for an account (`?id=`), its archive history (`?id=&history=true&limit=`), or the
 * customers identity proposes for archive under the owner's dormancy period (`?proposals=true`). POST runs one step of a
 * two-founder request: the first founder proposes at identity, the other founder approves the same account, version,
 * reason code and reason, and identity's archive spends the approval once.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('accounts');
  if (disabled) return disabled;
  try {
    const { session, config } = await authorizeAdminRequest(request);
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some((key) => !['id', 'history', 'limit', 'proposals'].includes(key)))
      throw new AdminSessionError('admin.accounts_input', 400);
    if (params.get('proposals') === 'true') {
      if (params.size !== 1) throw new AdminSessionError('admin.accounts_input', 400);
      const data = await founderEdgeCall(config, 'identity', 'accountControls.archiveProposals', 'GET', {}, session.accessToken);
      if (!accountArchiveProposalsSchema.safeParse(data).success) throw new AdminSessionError('admin.upstream_invalid', 502);
      return Response.json(data, { headers: { 'cache-control': 'no-store' } });
    }
    const userId = params.get('id')?.toLowerCase();
    const history = params.get('history') === 'true';
    const parsed = history
      ? accountArchiveHistoryInputSchema.safeParse({ userId, limit: Number(params.get('limit')) })
      : accountArchiveLookupInputSchema.safeParse({ userId });
    if (!parsed.success) throw new AdminSessionError('admin.accounts_input', 400);
    const data = await founderEdgeCall(
      config,
      'identity',
      history ? 'accountControls.archiveHistory' : 'accountControls.archiveState',
      'GET',
      parsed.data,
      session.accessToken,
    );
    const valid = history
      ? Array.isArray(data) &&
        data.length <= Number(params.get('limit')) &&
        data.every((row) => {
          const parsedRow = accountArchiveResultSchema.safeParse(row);
          return parsedRow.success && parsedRow.data.userId === parsed.data.userId;
        })
      : data === null ||
        (() => {
          const state = accountArchiveStateSchema.safeParse(data);
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
    kinds: ['identity.account.archive'],
    check: () => null,
    execute: archiveExecute(session),
  });
}
