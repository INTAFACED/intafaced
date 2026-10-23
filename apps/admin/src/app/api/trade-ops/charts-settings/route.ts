import { tradeOpsRoute } from '@/lib/trade-ops/bff';
import { readMatchingApproval } from '@/lib/trade-ops/matching-edge';
import { ok, refused, type Outcome } from '@/lib/trade-ops/outcome';
import type { TradeCtx } from '@/lib/trade-ops/edge';
import {
  CHART_DATA_CLASSES,
  CHART_DATA_CLASS_ACTION_TYPE,
  CHART_SCALAR_KEYS,
  CHART_DATA_CLASS_TARGET_SERVICE,
  parseWholeNumberText,
  reasonReady,
  type ChartDataClass,
  type ChartScalarKey,
} from '@/lib/trade-ops/charts-owner-values-model';
import { chartDataClassPayloadHash, chartScalarClientRequestId } from '@/lib/trade-ops/charts-owner-values-hash';
import {
  proposeChartDataClass,
  readChartOwnerValues,
  writeChartDataClass,
  writeChartScalar,
} from '@/lib/trade-ops/charts-owner-values-calls';

/**
 * Charts owner values room (C-ops-04, LD-14), through svc-trade `admin.chartOwnerValues.*`.
 *
 *   POST { action: 'read' }                                                           the scalars, every market's data class, canWrite
 *   POST { action: 'set',     key, value, expectedVersion, reason }                   one count; value '' clears it to not set
 *   POST { action: 'hash',    symbol, dataClass, expectedVersion, reason }            the hash a second founder is shown (no call)
 *   POST { action: 'propose', symbol, dataClass, expectedVersion, reason }            file the two-person request for a data class
 *   POST { action: 'apply',   symbol, dataClass, expectedVersion, reason, approvalId } write it, once the request is APPROVED
 *
 * The bounds on a count are svc-trade's: this route sends the whole number typed and shows the service's refusal. A reason
 * is required on every write. The data class needs a second founder's approval; the page never fills a value in.
 */
export const dynamic = 'force-dynamic';

const TOKEN = /^[A-Za-z0-9_.:-]{1,128}$/;
const VERSION = /^(?:0|[1-9]\d*)$/;

const bad = (code: string, message: string) => refused(code, message, 400);

type Body = Record<string, unknown>;

function scalarKeyOf(raw: unknown): ChartScalarKey | null {
  return typeof raw === 'string' && (CHART_SCALAR_KEYS as readonly string[]).includes(raw) ? (raw as ChartScalarKey) : null;
}

/** A data class from the page: '' or null is "not set", anything else must be one of the three classes. */
function dataClassOf(raw: unknown): { ok: true; value: ChartDataClass | null } | { ok: false } {
  if (raw === null || raw === '' || raw === undefined) return { ok: true, value: null };
  if (typeof raw === 'string' && (CHART_DATA_CLASSES as readonly string[]).includes(raw)) return { ok: true, value: raw as ChartDataClass };
  return { ok: false };
}

async function handler(ctx: TradeCtx, body: Body): Promise<Outcome<unknown>> {
  const action = body.action;

  if (action === 'read') return readChartOwnerValues(ctx);

  if (action !== 'set' && action !== 'hash' && action !== 'propose' && action !== 'apply')
    return bad('trade_ops.bad_action', 'Unknown charts settings action.');

  const expectedVersion = typeof body.expectedVersion === 'string' && VERSION.test(body.expectedVersion) ? body.expectedVersion : null;
  if (expectedVersion === null) return bad('chart_owner_value.bad_version', 'Read the values again: the version on the form is missing.');
  if (typeof body.reason !== 'string' || !reasonReady(body.reason))
    return bad('chart_owner_value.reason_required', 'Write the reason for this change (at least 12 characters). It is kept in the audit.');
  const reason = body.reason.trim();

  if (action === 'set') {
    const key = scalarKeyOf(body.key);
    if (key === null) return bad('chart_owner_value.bad_key', 'Unknown charts setting.');
    if (typeof body.value !== 'string')
      return bad('chart_owner_value.not_whole', 'Enter a whole number, or leave it blank to clear the value.');
    const parsed = parseWholeNumberText(body.value);
    if (!parsed.ok) return bad('chart_owner_value.not_whole', parsed.message);
    return writeChartScalar(ctx, {
      key,
      value: parsed.value,
      expectedVersion,
      reason,
      clientRequestId: chartScalarClientRequestId(key, expectedVersion, parsed.value, reason),
    });
  }

  // Data class: the market and the new class come from the page; the service checks the market exists.
  if (typeof body.symbol !== 'string' || body.symbol.trim() === '' || body.symbol.trim().length > 64)
    return bad('chart_owner_value.bad_symbol', 'Choose a market.');
  const symbol = body.symbol.trim();
  const dataClass = dataClassOf(body.dataClass);
  if (!dataClass.ok) return bad('chart_owner_value.bad_data_class', 'Choose real time, delayed, end of day, or not set.');
  const payload = { symbol, dataClass: dataClass.value, expectedVersion, reason };

  if (action === 'hash') return ok({ payloadHash: chartDataClassPayloadHash(payload), expectedVersion });
  if (action === 'propose') return proposeChartDataClass(ctx, payload);

  // apply
  if (typeof body.approvalId !== 'string' || !TOKEN.test(body.approvalId.trim()))
    return bad('trade_ops.approval_id_invalid', 'Enter the id of an APPROVED request.');
  const approvalId = body.approvalId.trim();
  const approval = await readMatchingApproval(ctx, approvalId);
  if (approval.kind !== 'ok') return approval;
  const a = approval.data;
  if (a.status !== 'APPROVED')
    return refused(
      a.status === 'PENDING' ? 'action_approval.pending' : 'action_approval.not_approved',
      a.status === 'PENDING'
        ? 'This request is still waiting for a second founder. Nothing was written.'
        : `This request is ${a.status}, not APPROVED. Nothing was written.`,
      409,
    );
  // The approval must be for this data class change, on this market, with exactly these values. Anything else is refused
  // here, before svc-trade is called; svc-trade checks it again when it consumes the approval.
  if (a.actionType !== CHART_DATA_CLASS_ACTION_TYPE || a.targetService !== CHART_DATA_CLASS_TARGET_SERVICE || a.targetId !== symbol)
    return refused('chart_owner_value.approval_mismatch', 'That approval is for a different change. Nothing was written.', 409);
  if (a.payloadHash !== chartDataClassPayloadHash(payload))
    return refused('chart_owner_value.approval_mismatch', 'That approval is for different values. Nothing was written.', 409);

  // Write under the approval's own operation id: identity minted it at propose, and svc-trade consumes only with it.
  return writeChartDataClass(ctx, { ...payload, approvalId, clientRequestId: a.operationId });
}

export const POST = (req: Request) => tradeOpsRoute(req, handler);
