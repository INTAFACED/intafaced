import { moduleDisabledResponse } from '@/lib/modules';
import {
  accountControlHistoryInputSchema,
  accountControlInputSchema,
  accountControlLookupInputSchema,
  accountControlResultSchema,
  accountControlStateSchema,
  type AccountControlTarget,
} from '@intafaced/contracts';
import {
  adminSessionErrorResponse,
  AdminSessionError,
  authorizeAdminRequest,
  founderEdgeCall,
  founderEdgeRecordCall,
} from '@/lib/founder-session';
import {
  IDENTITY_ACCOUNT_CONTROLS_CHANGE,
  IDENTITY_ACCOUNT_CONTROLS_GET_STATE,
  IDENTITY_ACCOUNT_CONTROLS_HISTORY,
} from '@intafaced/contracts/identity-account-controls-procedures';
import { TRADE_ACCOUNT_CONTROLS_GET_STATE, TRADE_ACCOUNT_CONTROLS_HISTORY } from '@intafaced/contracts/trade-account-controls-procedures';
import {
  PAY_ACCOUNT_CONTROLS_CHANGE,
  PAY_ACCOUNT_CONTROLS_GET_STATE,
  PAY_ACCOUNT_CONTROLS_HISTORY,
} from '@intafaced/contracts/pay-account-controls-procedures';
import { readAdminJson } from '@/lib/admin-json';

export const dynamic = 'force-dynamic';

/** Each area's controls, read through the records of the service that owns that area. */
const READS = {
  identity: { getState: IDENTITY_ACCOUNT_CONTROLS_GET_STATE, history: IDENTITY_ACCOUNT_CONTROLS_HISTORY },
  trading: { getState: TRADE_ACCOUNT_CONTROLS_GET_STATE, history: TRADE_ACCOUNT_CONTROLS_HISTORY },
  merchant: { getState: PAY_ACCOUNT_CONTROLS_GET_STATE, history: PAY_ACCOUNT_CONTROLS_HISTORY },
} as const;
function sameTarget(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function GET(request: Request) {
  const disabled = moduleDisabledResponse('accounts');
  if (disabled) return disabled;
  try {
    const { session, config } = await authorizeAdminRequest(request);
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some((key) => !['area', 'id', 'history', 'limit'].includes(key)))
      throw new AdminSessionError('admin.accounts_input', 400);
    const area = params.get('area');
    const id = params.get('id')?.toLowerCase();
    const target = area === 'merchant' ? { area, merchantId: id } : { area, userId: id };
    const history = params.get('history') === 'true';
    let parsed: { data: { target: AccountControlTarget } };
    let data: unknown;
    if (history) {
      const asked = accountControlHistoryInputSchema.safeParse({ target, limit: Number(params.get('limit')) });
      if (!asked.success) throw new AdminSessionError('admin.accounts_input', 400);
      parsed = asked;
      data = await founderEdgeRecordCall(config, READS[asked.data.target.area].history, asked.data, session.accessToken);
    } else {
      const asked = accountControlLookupInputSchema.safeParse({ target });
      if (!asked.success) throw new AdminSessionError('admin.accounts_input', 400);
      parsed = asked;
      data = await founderEdgeRecordCall(config, READS[asked.data.target.area].getState, asked.data, session.accessToken);
    }
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
  const disabled = moduleDisabledResponse('accounts');
  if (disabled) return disabled;
  try {
    const { session, config } = await authorizeAdminRequest(request);
    const parsed = accountControlInputSchema.safeParse(await readAdminJson(request));
    if (!parsed.success) throw new AdminSessionError('admin.accounts_input', 400);
    parsed.data.requestId = parsed.data.requestId.toLowerCase();
    if (parsed.data.target.area === 'merchant') parsed.data.target.merchantId = parsed.data.target.merchantId.toLowerCase();
    else parsed.data.target.userId = parsed.data.target.userId.toLowerCase();
    // Trading's change keeps its call by name: its input grows an approval id when the four-eyes setting is on.
    const area = parsed.data.target.area;
    const data: unknown =
      area === 'trading'
        ? await founderEdgeCall(config, 'trade', 'accountControls.change', 'POST', parsed.data, session.accessToken)
        : await founderEdgeRecordCall(
            config,
            area === 'identity' ? IDENTITY_ACCOUNT_CONTROLS_CHANGE : PAY_ACCOUNT_CONTROLS_CHANGE,
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
