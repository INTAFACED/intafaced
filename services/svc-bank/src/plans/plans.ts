import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { BankError } from '../errors.js';

/**
 * PLANS AND THE ACCOUNT FEE TABLE (BK-acct-04, J-bank-16 #6). Both are owner tables, read from the environment.
 *
 * `BANK_PLANS_JSON`: `{ "defaultPlanId": "<id>", "plans": [{ "id", "name", "tier", "price", "assetId", "period": "month" }] }`.
 * NO DEFAULT: blank or not in shape, `plans.list` refuses `bank.plans_unset`. A person who never subscribed is on the
 * default plan. Subscribing or switching to a paid plan is a fee posting, which needs a plan-fee recipe in ledger-client
 * that does not exist yet, so a paid plan reads `bank.plan_fee_unwired` and nothing is charged.
 *
 * `BANK_FEE_SCHEDULE_JSON`: `{ "lines": [{ "id", "label", "fee", "assetId" }] }`. Blank is not an error: it is the owner
 * having published no account fee table, and the page says "not set". Nothing is charged from it here.
 */

export interface Plan {
  readonly id: string;
  readonly name: string;
  readonly tier: string;
  readonly price: string;
  readonly assetId: string;
  readonly period: 'month';
}
export interface PlanTable {
  readonly defaultPlanId: string;
  readonly plans: readonly Plan[];
}
export interface FeeLine {
  readonly id: string;
  readonly label: string;
  readonly fee: string;
  readonly assetId: string;
}

const ID = /^[a-z][a-z0-9-]{0,31}$/;
const text = (v: unknown, max = 80): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
function amount(v: unknown): string | null {
  if (typeof v !== 'string' || !/^\d+(\.\d{1,18})?$/.test(v)) return null;
  return formatAmount(parseAmount(v));
}

/** The owner's plan table, or null when blank or not in shape (the read then refuses `bank.plans_unset`). */
export function parsePlans(raw: string | undefined): PlanTable | null {
  if (!raw?.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const o = parsed as { defaultPlanId?: unknown; plans?: unknown };
  if (!Array.isArray(o.plans) || o.plans.length === 0 || typeof o.defaultPlanId !== 'string') return null;
  const plans: Plan[] = [];
  for (const p of o.plans as Array<Record<string, unknown>>) {
    const price = amount(p.price);
    if (typeof p.id !== 'string' || !ID.test(p.id) || !text(p.name) || !text(p.tier, 32) || price === null) return null;
    if (!text(p.assetId, 16) || p.period !== 'month') return null;
    plans.push({ id: p.id, name: p.name, tier: p.tier, price, assetId: p.assetId, period: 'month' });
  }
  if (new Set(plans.map((p) => p.id)).size !== plans.length) return null;
  if (!plans.some((p) => p.id === o.defaultPlanId)) return null;
  return { defaultPlanId: o.defaultPlanId, plans };
}

/** The owner's account fee table: its lines, or null when none is published (the page says "not set"). */
export function parseFeeTable(raw: string | undefined): FeeLine[] | null {
  if (!raw?.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const lines = (parsed as { lines?: unknown }).lines;
  if (!Array.isArray(lines) || lines.length === 0) return null;
  const out: FeeLine[] = [];
  for (const l of lines as Array<Record<string, unknown>>) {
    const fee = amount(l.fee);
    if (typeof l.id !== 'string' || !ID.test(l.id) || !text(l.label) || fee === null || !text(l.assetId, 16)) return null;
    out.push({ id: l.id, label: l.label, fee, assetId: l.assetId });
  }
  return out;
}

/** The plans on offer and the one the person is on: the default plan, as nobody can subscribe until a plan fee posts. */
export function planView(table: PlanTable | null): {
  plans: readonly (Plan & { blocker: 'bank.plan_fee_unwired' | null })[];
  current: Plan;
} {
  if (!table) throw new BankError('No plan table is published, so no plan can be shown', 'bank.plans_unset');
  const plans = table.plans.map((p) => ({ ...p, blocker: parseAmount(p.price) > 0n ? ('bank.plan_fee_unwired' as const) : null }));
  return { plans, current: table.plans.find((p) => p.id === table.defaultPlanId)! };
}
