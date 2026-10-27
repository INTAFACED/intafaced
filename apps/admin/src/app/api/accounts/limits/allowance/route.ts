import { withdrawalAllowanceInputSchema, withdrawalAllowanceSchema } from '@intafaced/contracts';
import { moduleDisabledResponse } from '@/lib/modules';
import { allowanceAssets, type AllowanceRow } from '@/lib/accounts/limits';
import { adminSessionErrorResponse, AdminSessionError, authorizeAdminRequest, founderEdgeCall } from '@/lib/founder-session';

/**
 * One customer's withdrawal allowances (J-ops-console-04 #12), from the service that enforces them, svc-pay (`?id=`). The
 * assets are the ones svc-pay has a base limit set for (`founderAdmin.limits.list`); for each, `founderAdmin.limits.customer`
 * gives the base figure for the customer's verification level, a founder's override in force, what the last 24 hours used
 * and what is left, read the way the withdrawal guard reads it. An asset svc-pay refuses carries svc-pay's own code, never
 * a guessed figure. The founder is checked once for the whole read.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('accounts');
  if (disabled) return disabled;
  try {
    const { session, config } = await authorizeAdminRequest(request);
    const params = new URL(request.url).searchParams;
    if (params.size !== 1 || !params.has('id')) throw new AdminSessionError('admin.accounts_input', 400);
    const userId = params.get('id')?.toLowerCase();
    if (!withdrawalAllowanceInputSchema.shape.userId.safeParse(userId).success) throw new AdminSessionError('admin.accounts_input', 400);
    const assets = allowanceAssets(await founderEdgeCall(config, 'pay', 'founderAdmin.limits.list', 'GET', {}, session.accessToken));
    if (assets === null) throw new AdminSessionError('admin.upstream_invalid', 502);
    const rows: AllowanceRow[] = [];
    for (const assetId of assets) {
      try {
        const data = await founderEdgeCall(config, 'pay', 'founderAdmin.limits.customer', 'GET', { userId, assetId }, session.accessToken);
        const allowance = withdrawalAllowanceSchema.safeParse(data);
        rows.push(
          allowance.success && allowance.data.assetId === assetId
            ? { assetId, allowance: allowance.data }
            : { assetId, refused: 'admin.upstream_invalid' },
        );
      } catch (error) {
        if (!(error instanceof AdminSessionError) || error.code === 'admin.authority_refused') throw error;
        rows.push({ assetId, refused: error.upstream ?? error.code });
      }
    }
    return Response.json({ rows }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
