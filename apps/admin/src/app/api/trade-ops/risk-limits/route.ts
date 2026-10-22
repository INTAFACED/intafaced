import { tradeOpsRoute } from '@/lib/trade-ops/bff';
import { proposeRiskSet, readRisk, readRiskHistory, writeRisk } from '@/lib/trade-ops/desk-reads';
import type { RiskCurrent, RiskVersionRow } from '@/lib/trade-ops/desk-parse';
import type { TradeCtx } from '@/lib/trade-ops/edge';
import { ok, refused, type Outcome } from '@/lib/trade-ops/outcome';
import { readMatchingApproval } from '@/lib/trade-ops/matching-edge';
import { checkRiskSet, ENGINE_CHECKS, type OperatorLimitField } from '@/lib/trade-ops/risk-limits-model';
import { riskSetPayloadHash } from '@/lib/trade-ops/risk-set-hash';

/**
 * Risk limits room, operator limits of one market, through svc-trade `admin.risk.*`.
 *
 *   POST { action: 'read',    market }                              current limits and every earlier version
 *   POST { action: 'hash',    market, values, reason }              the hash a second founder will be shown (no call)
 *   POST { action: 'propose', market, values, reason }              file the two-person request for the change
 *   POST { action: 'apply',   market, values, reason, approvalId }  write it, once the request is APPROVED
 *
 * `values` holds the five limits as text; a blank one is unset. A change is checked against the version just read, so
 * a stale form is refused here and again by the service.
 */
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_.:-]{1,128}$/;

function valuesOf(raw: unknown): Record<OperatorLimitField, string> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const out = {} as Record<OperatorLimitField, string>;
  for (const check of ENGINE_CHECKS) {
    const v = input[check.field];
    if (v !== undefined && typeof v !== 'string') return null;
    out[check.field] = v ?? '';
  }
  return out;
}

async function handler(ctx: TradeCtx, body: Record<string, unknown>): Promise<Outcome<unknown>> {
  const action = body.action;
  if (typeof body.market !== 'string' || !UUID.test(body.market)) return refused('trade_ops.risk_bad_market', 'Choose a market.', 400);
  const market = body.market;

  if (action === 'read') {
    const [current, history] = await Promise.all([readRisk(ctx, market), readRiskHistory(ctx, market)]);
    if (current.kind !== 'ok') return current;
    if (history.kind !== 'ok') return history;
    return ok<{ current: RiskCurrent; history: readonly RiskVersionRow[] }>({ current: current.data, history: history.data }, current.asOf);
  }

  if (action !== 'hash' && action !== 'propose' && action !== 'apply')
    return refused('trade_ops.bad_action', 'Unknown risk limits action.', 400);
  const values = valuesOf(body.values);
  if (!values) return refused('risk_limits.bad_value', 'The limits must be text.', 400);

  // Always against the version the service holds now: a form built on an older read is refused, not applied.
  const current = await readRisk(ctx, market);
  if (current.kind !== 'ok') return current;
  const check = checkRiskSet(current.data, values, body.reason);
  if (!check.ok) return refused(check.code, check.message, 400);
  if (typeof body.expectedVersion === 'string' && body.expectedVersion !== current.data.version)
    return refused(
      'risk_limit_stale',
      `The limits changed since you read them (now version ${current.data.version}). Read them again.`,
      409,
    );

  if (action === 'hash') return ok({ payloadHash: riskSetPayloadHash(check.body), expectedVersion: check.body.expectedVersion });
  if (action === 'propose') return proposeRiskSet(ctx, check.body);
  if (typeof body.approvalId !== 'string' || !TOKEN.test(body.approvalId.trim()))
    return refused('trade_ops.approval_id_invalid', 'Enter the id of an APPROVED request.', 400);
  const approvalId = body.approvalId.trim();
  // The write is bound to the approval's own operation id, which identity minted when the change was proposed.
  const approval = await readMatchingApproval(ctx, approvalId);
  if (approval.kind !== 'ok') return approval;
  if (approval.data.status !== 'APPROVED')
    return refused(
      approval.data.status === 'PENDING' ? 'action_approval.pending' : 'action_approval.not_approved',
      approval.data.status === 'PENDING'
        ? 'This request is still waiting for a second founder. Nothing was written.'
        : `This request is ${approval.data.status}, not APPROVED. Nothing was written.`,
      409,
    );
  return writeRisk(ctx, { ...check.body, approvalId, operationId: approval.data.operationId });
}

export const POST = (req: Request) => tradeOpsRoute(req, handler);
