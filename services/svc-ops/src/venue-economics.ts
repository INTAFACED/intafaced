import {
  OPS_COST_CATEGORIES,
  opsCostAmountSchema,
  opsCostPeriodSchema,
  type OpsCostCategory,
  type OpsCostEntry,
  type OpsCostEntryInput,
  type OpsVenueEconomics,
} from '@intafaced/contracts';
import { OPS_COST_AMOUNT_INVALID, OPS_COST_CATEGORY_INVALID, OPS_COST_PERIOD_INVALID, OpsError } from './codes.js';
import type { FeeRevenueRead } from './fee-revenue-client.js';
import type { RevenueResult } from './ops-service.js';
import { trimDecimal, type VenueCostFields } from './venue-cost-store.js';

/**
 * Exact sum of two non-negative decimal strings, digit by digit, so no cost passes through a JS number. svc-ops does not
 * depend on ledger-client, whose money.ts is the canonical decimal arithmetic; swap this for it when it may.
 */
export function addDecimalStrings(a: string, b: string): string {
  const [aWhole = '0', aFrac = ''] = a.split('.');
  const [bWhole = '0', bFrac = ''] = b.split('.');
  const fracLen = Math.max(aFrac.length, bFrac.length);
  const wholeLen = Math.max(aWhole.length, bWhole.length);
  const left = aWhole.padStart(wholeLen, '0') + aFrac + '0'.repeat(fracLen - aFrac.length);
  const right = bWhole.padStart(wholeLen, '0') + bFrac + '0'.repeat(fracLen - bFrac.length);
  let carry = 0;
  let digits = '';
  for (let i = left.length - 1; i >= 0; i--) {
    const d = Number(left[i]) + Number(right[i]) + carry;
    digits = String(d % 10) + digits;
    carry = d >= 10 ? 1 : 0;
  }
  if (carry) digits = '1' + digits;
  const split = digits.length - fracLen;
  const whole = digits.slice(0, split).replace(/^0+(?=\d)/, '') || '0';
  return trimDecimal(fracLen === 0 ? whole : `${whole}.${digits.slice(split)}`);
}

function aligned(a: string, b: string): { left: string; right: string; fracLen: number } {
  const [aWhole = '0', aFrac = ''] = a.split('.');
  const [bWhole = '0', bFrac = ''] = b.split('.');
  const fracLen = Math.max(aFrac.length, bFrac.length);
  const wholeLen = Math.max(aWhole.length, bWhole.length);
  return {
    left: aWhole.padStart(wholeLen, '0') + aFrac + '0'.repeat(fracLen - aFrac.length),
    right: bWhole.padStart(wholeLen, '0') + bFrac + '0'.repeat(fracLen - bFrac.length),
    fracLen,
  };
}

/** `a` minus `b` for non-negative decimal strings with `a` not below `b`, digit by digit. */
function subtractNonNegative(a: string, b: string): string {
  const { left, right, fracLen } = aligned(a, b);
  let borrow = 0;
  let digits = '';
  for (let i = left.length - 1; i >= 0; i--) {
    let d = Number(left[i]) - Number(right[i]) - borrow;
    borrow = d < 0 ? 1 : 0;
    if (d < 0) d += 10;
    digits = String(d) + digits;
  }
  const split = digits.length - fracLen;
  const whole = digits.slice(0, split).replace(/^0+(?=\d)/, '') || '0';
  return trimDecimal(fracLen === 0 ? whole : `${whole}.${digits.slice(split)}`);
}

function atLeast(a: string, b: string): boolean {
  const { left, right } = aligned(a, b);
  return left >= right;
}

/** `revenue` (may be negative) minus `costs` (not negative), exact. A zero result carries no sign. */
export function subtractCosts(revenue: string, costs: string): string {
  if (revenue.startsWith('-')) return `-${addDecimalStrings(revenue.slice(1), costs)}`;
  if (atLeast(revenue, costs)) return subtractNonNegative(revenue, costs);
  return `-${subtractNonNegative(costs, revenue)}`;
}

/** The calendar month in UTC as the half-open window the ledger is asked about: first of the month, first of the next. */
export function periodWindow(period: string): { from: Date; to: Date } {
  const [year, month] = period.split('-').map(Number) as [number, number];
  return { from: new Date(Date.UTC(year, month - 1, 1)), to: new Date(Date.UTC(year, month, 1)) };
}

/** Whole part `0` or no leading zero and up to 20 digits; up to 18 decimals. */
export const COST_AMOUNT_STORABLE = /^(0|[1-9]\d{0,19})(\.\d{1,18})?$/;

export function parseCostPeriod(period: string): string {
  if (!opsCostPeriodSchema.safeParse(period).success) {
    throw new OpsError(OPS_COST_PERIOD_INVALID, 'period is a month like 2026-10');
  }
  return period;
}

/** Validates what the operator typed. Each failure is its own typed code, before any approval is spent. */
export function parseCostEntry(input: Pick<OpsCostEntryInput, 'period' | 'category' | 'amount' | 'asset' | 'sourceNote'>): VenueCostFields {
  parseCostPeriod(input.period);
  const category = OPS_COST_CATEGORIES.find((c) => c === input.category);
  if (!category) {
    throw new OpsError(OPS_COST_CATEGORY_INVALID, `category is one of ${OPS_COST_CATEGORIES.join(', ')}`);
  }
  // Stricter than the wire schema: no leading zeros (the stored form would differ from what the approver signed) and at most 20
  // whole digits (numeric(38,18)), so a value the column cannot hold is refused before the approval is spent.
  const amount = opsCostAmountSchema.safeParse(input.amount);
  if (!amount.success || !COST_AMOUNT_STORABLE.test(input.amount)) {
    throw new OpsError(
      OPS_COST_AMOUNT_INVALID,
      'amount is a non-negative decimal string with no leading zeros, at most 20 whole digits and 18 decimals; no cost is guessed',
    );
  }
  if (!/^[A-Z0-9]{2,12}$/.test(input.asset)) {
    throw new OpsError(OPS_COST_AMOUNT_INVALID, 'asset is an upper-case code such as USD');
  }
  const sourceNote = input.sourceNote.trim();
  if (sourceNote.length < 1 || sourceNote.length > 500) {
    throw new OpsError(OPS_COST_AMOUNT_INVALID, 'a source note of 1 to 500 characters is required');
  }
  return { period: input.period, category, amount: trimDecimal(input.amount), asset: input.asset, sourceNote };
}

/** Revenue as the warehouse read answered, or the typed code it refused with. */
export type RevenueRead = { ok: true; value: RevenueResult } | { ok: false; code: string; message: string };

export async function readRevenue(read: () => Promise<RevenueResult>): Promise<RevenueRead> {
  try {
    return { ok: true, value: await read() };
  } catch (err) {
    if (err instanceof OpsError) return { ok: false, code: err.code, message: err.message };
    throw err;
  }
}

/**
 * The cost side is whatever was entered. A category with no entry is `not_entered`, never zero; the
 * latest version of an entered category is current and every version stays in its history.
 *
 * Net comes from the ledger's fee revenue, per asset, never from the warehouse points (they carry no asset). It is given
 * only when the ledger answered and every cost line is entered; otherwise it says which is missing. An asset with revenue
 * and no cost in it has a truthful cost of zero once all seven lines are in; an asset with costs and no fee movement has
 * revenue zero for the same reason: the ledger answered and booked none.
 */
export function composeVenueEconomics(
  asOf: string,
  period: string,
  revenue: RevenueRead,
  entries: readonly OpsCostEntry[],
  fees?: FeeRevenueRead,
): OpsVenueEconomics {
  const costs = OPS_COST_CATEGORIES.map((category: OpsCostCategory) => {
    const history = entries.filter((e) => e.category === category).sort((a, b) => a.version - b.version);
    const current = history[history.length - 1];
    return current ? { status: 'entered' as const, category, current, history } : { status: 'not_entered' as const, category };
  });
  const missing = costs.filter((c) => c.status === 'not_entered').map((c) => c.category);
  const sums = new Map<string, string>();
  for (const line of costs) {
    if (line.status === 'entered')
      sums.set(line.current.asset, addDecimalStrings(sums.get(line.current.asset) ?? '0', line.current.amount));
  }
  return {
    asOf,
    period: period as OpsVenueEconomics['period'],
    revenue: revenue.ok
      ? {
          status: 'ok',
          empty: revenue.value.empty,
          freshness: revenue.value.freshness,
          points: revenue.value.points.map((p) => ({ metricId: p.metricId, value: p.value, dim: p.dim ?? null })),
        }
      : { status: 'unavailable', code: revenue.code, message: revenue.message },
    costs,
    completeness: missing.length === 0 ? { status: 'complete' } : { status: 'incomplete', missing },
    costTotals: {
      partial: missing.length > 0,
      byAsset: [...sums.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([asset, amount]) => ({ asset, amount })),
    },
    ...(fees
      ? {
          feeRevenue: fees.ok
            ? { status: 'ok' as const, assets: fees.value.assets }
            : { status: 'unavailable' as const, code: fees.code, message: fees.message },
        }
      : {}),
    net: composeNet(fees, missing.length, sums),
  };
}

function composeNet(fees: FeeRevenueRead | undefined, missing: number, costs: ReadonlyMap<string, string>): OpsVenueEconomics['net'] {
  if (!fees) return { status: 'unavailable', reason: 'revenue_asset_unknown' };
  if (!fees.ok) return { status: 'unavailable', reason: 'revenue_unavailable' };
  if (missing > 0) return { status: 'unavailable', reason: 'costs_incomplete' };
  const revenue = new Map(fees.value.assets.map((a) => [a.assetId, a.net]));
  const assets = [...new Set([...revenue.keys(), ...costs.keys()])].sort((a, b) => a.localeCompare(b));
  return {
    status: 'ok',
    byAsset: assets.map((asset) => {
      const earned = revenue.get(asset) ?? '0';
      const spent = costs.get(asset) ?? '0';
      return { asset, revenue: earned, costs: spent, net: subtractCosts(earned, spent) };
    }),
  };
}
