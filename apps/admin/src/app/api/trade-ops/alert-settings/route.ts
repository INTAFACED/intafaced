import { tradeOpsRoute } from '@/lib/trade-ops/bff';
import { refused, type Outcome } from '@/lib/trade-ops/outcome';
import type { TradeCtx } from '@/lib/trade-ops/edge';
import { parseWholeNumberText, reasonReady } from '@/lib/trade-ops/charts-owner-values-model';
import { ALERT_PLANS, type AlertPlan } from '@/lib/trade-ops/alert-owner-values-model';
import { readAlertOwnerValues, writeAlertOwnerValue } from '@/lib/trade-ops/alert-owner-values-calls';

/**
 * Alert owner values (J-charts-desk-18 #5 #6), through svc-notify `notify.opsAlertOwnerValues.*`.
 *
 *   POST { action: 'read' }                                              every value, its source, and the history
 *   POST { action: 'set', key, plan, value, expectedVersion, reason }    one value; value '' clears it to not set
 *
 * The bounds are svc-notify's: this route sends the whole number typed and shows the service's refusal.
 */
export const dynamic = 'force-dynamic';

const VERSION = /^(?:0|[1-9]\d*)$/;
const bad = (code: string, message: string) => refused(code, message, 400);

async function handler(ctx: TradeCtx, body: Record<string, unknown>): Promise<Outcome<unknown>> {
  if (body.action === 'read') return readAlertOwnerValues(ctx);
  if (body.action !== 'set') return bad('trade_ops.bad_action', 'Unknown alert settings action.');
  const key = body.key === 'priceQuota' || body.key === 'triggerLogDays' ? body.key : null;
  if (key === null) return bad('alert_owner_value.bad_key', 'Unknown alert setting.');
  let plan: AlertPlan | null = null;
  if (key === 'priceQuota') {
    if (typeof body.plan !== 'string' || !(ALERT_PLANS as readonly string[]).includes(body.plan))
      return bad('alert_owner_value.bad_plan', 'Choose the plan this quota is for.');
    plan = body.plan as AlertPlan;
  }
  const expectedVersion = typeof body.expectedVersion === 'string' && VERSION.test(body.expectedVersion) ? body.expectedVersion : null;
  if (expectedVersion === null) return bad('alert_owner_value.bad_version', 'Read the values again: the version on the form is missing.');
  if (typeof body.reason !== 'string' || !reasonReady(body.reason))
    return bad('alert_owner_value.reason_required', 'Write the reason for this change (at least 12 characters). It is kept in the audit.');
  if (typeof body.value !== 'string')
    return bad('alert_owner_value.not_whole', 'Enter a whole number, or leave it blank to clear the value.');
  const parsed = parseWholeNumberText(body.value);
  if (!parsed.ok) return bad('alert_owner_value.not_whole', parsed.message);
  return writeAlertOwnerValue(ctx, { key, plan, value: parsed.value, expectedVersion, reason: body.reason.trim() });
}

export const POST = (req: Request) => tradeOpsRoute(req, handler);
