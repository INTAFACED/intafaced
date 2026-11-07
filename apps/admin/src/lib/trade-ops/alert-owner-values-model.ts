/**
 * The alert owner values (C-ops-04, C-alerts-scan-03; J-charts-desk-18 #5 #6) as svc-notify
 * `notify.opsAlertOwnerValues.get` answers them, parsed. Client-safe. No number is held here: the bounds are svc-notify's.
 */

/** A plan id of the owner's account plan table (BK-acct-04). */
export type AlertPlan = string;
export type AlertOwnerKey = 'priceQuota' | 'triggerLogDays';
export const PLAN_ID = /^[a-z][a-z0-9-]{0,31}$/;

export interface AccountPlans {
  readonly defaultPlanId: string;
  readonly plans: readonly { readonly id: string; readonly name: string }[];
}

export interface OwnerValueView {
  readonly key: AlertOwnerKey;
  readonly plan: AlertPlan | null;
  readonly value: number | null;
  readonly source: 'page' | 'deployment';
  readonly version: string;
  readonly operatorId: string | null;
  readonly reason: string | null;
  readonly updatedAt: string | null;
}

export interface OwnerValueChange {
  readonly id: string;
  readonly key: AlertOwnerKey;
  readonly plan: AlertPlan | null;
  readonly oldValue: number | null;
  readonly newValue: number | null;
  readonly operatorId: string;
  readonly reason: string;
  readonly at: string;
}

export interface AlertOwnerValuesView {
  /** The owner's plans, or null while the plan table is not set. */
  readonly plans: AccountPlans | null;
  readonly quotas: readonly OwnerValueView[];
  readonly triggerLogDays: OwnerValueView;
  readonly history: readonly OwnerValueChange[];
  readonly canWrite: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const intOrNull = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isInteger(v));
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
const isKey = (v: unknown): v is AlertOwnerKey => v === 'priceQuota' || v === 'triggerLogDays';
const isPlanOrNull = (v: unknown): v is AlertPlan | null => v === null || (typeof v === 'string' && PLAN_ID.test(v));

function parsePlans(v: unknown): AccountPlans | null | undefined {
  if (v === null) return null;
  if (!isObj(v) || typeof v.defaultPlanId !== 'string' || !Array.isArray(v.plans)) return undefined;
  const plans: { id: string; name: string }[] = [];
  for (const p of v.plans) {
    if (!isObj(p) || typeof p.id !== 'string' || typeof p.name !== 'string') return undefined;
    plans.push({ id: p.id, name: p.name });
  }
  return { defaultPlanId: v.defaultPlanId, plans };
}

function parseValue(v: unknown): OwnerValueView | null {
  if (!isObj(v) || !isKey(v.key) || !isPlanOrNull(v.plan) || !intOrNull(v.value)) return null;
  if ((v.source !== 'page' && v.source !== 'deployment') || typeof v.version !== 'string') return null;
  if (!strOrNull(v.operatorId) || !strOrNull(v.reason) || !strOrNull(v.updatedAt)) return null;
  return {
    key: v.key,
    plan: v.plan,
    value: v.value,
    source: v.source,
    version: v.version,
    operatorId: v.operatorId,
    reason: v.reason,
    updatedAt: v.updatedAt,
  };
}

export function parseAlertOwnerValuesView(raw: unknown): AlertOwnerValuesView | null {
  if (!isObj(raw) || !Array.isArray(raw.quotas) || !Array.isArray(raw.history) || typeof raw.canWrite !== 'boolean') return null;
  const quotas = raw.quotas.map(parseValue);
  const retention = parseValue(raw.triggerLogDays);
  const plans = parsePlans(raw.plans);
  if (quotas.some((q) => q === null) || retention === null || plans === undefined) return null;
  const history: OwnerValueChange[] = [];
  for (const h of raw.history) {
    if (!isObj(h) || typeof h.id !== 'string' || !isKey(h.key) || !isPlanOrNull(h.plan)) return null;
    if (!intOrNull(h.oldValue) || !intOrNull(h.newValue) || typeof h.operatorId !== 'string' || typeof h.reason !== 'string') return null;
    if (typeof h.at !== 'string') return null;
    history.push({
      id: h.id,
      key: h.key,
      plan: h.plan,
      oldValue: h.oldValue,
      newValue: h.newValue,
      operatorId: h.operatorId,
      reason: h.reason,
      at: h.at,
    });
  }
  return { plans, quotas: quotas as OwnerValueView[], triggerLogDays: retention, history, canWrite: raw.canWrite };
}

export const valueText = (v: number | null): string => (v === null ? 'Not set' : String(v));
export const sourceText = (v: OwnerValueView): string =>
  v.source === 'page' ? 'Set on this page' : 'Deployment setting (never set on this page)';
/** A plan's name from the owner's table, or its id when the table no longer lists it (an old history row). */
export const planName = (plans: AccountPlans | null, plan: AlertPlan | null): string =>
  plans?.plans.find((p) => p.id === plan)?.name ?? plan ?? '';
export const keyLabel = (plans: AccountPlans | null, key: AlertOwnerKey, plan: AlertPlan | null): string =>
  key === 'priceQuota' ? `Price alert quota, ${planName(plans, plan)}` : 'Trigger log retention (days)';
