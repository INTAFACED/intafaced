import {
  accountControlHistoryInputSchema,
  accountControlInputSchema,
  accountControlLookupInputSchema,
  accountControlResultSchema,
  accountControlStateSchema,
} from '@intafaced/contracts';
import { adminSessionErrorResponse, AdminSessionError, authorizeAdminRequest, founderEdgeCall } from '@/lib/founder-session';
import { readAdminJson } from '@/lib/admin-json';

export const dynamic = 'force-dynamic';

function moduleFor(area: string): 'identity' | 'trade' | 'pay' {
  if (area === 'identity') return 'identity';
  if (area === 'trading') return 'trade';
  return 'pay';
}
function sameTarget(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function GET(request: Request) {
  try {
    const { session, config } = await authorizeAdminRequest(request);
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some((key) => !['area', 'id', 'history', 'limit'].includes(key)))
      throw new AdminSessionError('admin.accounts_input', 400);
    const area = params.get('area');
    const id = params.get('id')?.toLowerCase();
    const target = area === 'merchant' ? { area, merchantId: id } : { area, userId: id };
    const history = params.get('history') === 'true';
    const parsed = history
      ? accountControlHistoryInputSchema.safeParse({ target, limit: Number(params.get('limit')) })
      : accountControlLookupInputSchema.safeParse({ target });
    if (!parsed.success) throw new AdminSessionError('admin.accounts_input', 400);
    const data = await founderEdgeCall(
      config,
      moduleFor(parsed.data.target.area),
      history ? 'accountControls.history' : 'accountControls.getState',
      'GET',
      parsed.data,
      session.accessToken,
    );
    const valid = history
      ? Array.isArray(data) &&
        data.length <= Number(params.get('limit')) &&
        data.every((row) => {
          const parsedRow = accountControlResultSchema.safeParse(row);
          return parsedRow.success && sameTarget(parsedRow.data.target, parsed.data.target);
        })
      : data === null ||
        (() => {
          const state = accountControlStateSchema.safeParse(data);
          return state.success && sameTarget(state.data.target, parsed.data.target);
        })();
    if (!valid) throw new AdminSessionError('admin.upstream_invalid', 502);
    return Response.json(data, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { session, config } = await authorizeAdminRequest(request);
    const parsed = accountControlInputSchema.safeParse(await readAdminJson(request));
    if (!parsed.success) throw new AdminSessionError('admin.accounts_input', 400);
    parsed.data.requestId = parsed.data.requestId.toLowerCase();
    if (parsed.data.target.area === 'merchant') parsed.data.target.merchantId = parsed.data.target.merchantId.toLowerCase();
    else parsed.data.target.userId = parsed.data.target.userId.toLowerCase();
    const data = await founderEdgeCall(
      config,
      moduleFor(parsed.data.target.area),
      'accountControls.change',
      'POST',
      parsed.data,
      session.accessToken,
    );
    const result = accountControlResultSchema.safeParse(data);
    if (!result.success) throw new AdminSessionError('admin.upstream_invalid', 502);
    if (
      result.data.requestId !== parsed.data.requestId ||
      result.data.action !== parsed.data.action ||
      result.data.reason !== parsed.data.reason ||
      !sameTarget(result.data.target, parsed.data.target) ||
      (result.data.actorUserId !== null && result.data.actorUserId !== session.userId.toLowerCase())
    )
      throw new AdminSessionError('admin.upstream_invalid', 502);
    return Response.json(result.data, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return adminSessionErrorResponse(error);
  }
}
