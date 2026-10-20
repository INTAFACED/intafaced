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
  const amount = opsCostAmountSchema.safeParse(input.amount);
  if (!amount.success) {
    throw new OpsError(OPS_COST_AMOUNT_INVALID, 'amount is a non-negative decimal string; no cost is guessed');
  }
  if (!/^[A-Z0-9]{2,12}$/.test(input.asset)) {
    throw new OpsError(OPS_COST_AMOUNT_INVALID, 'asset is an upper-case code such as USD');
  }
  const sourceNote = input.sourceNote.trim();
  if (sourceNote.length < 1 || sourceNote.length > 500) {
    throw new OpsError(OPS_COST_AMOUNT_INVALID, 'a source note of 1 to 500 characters is required');
  }
  return { period: input.period, category, amount: trimDecimal(amount.data), asset: input.asset, sourceNote };
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
 * latest version of an entered category is current and every version stays in its history. Net is
 * not derived: warehouse revenue points carry no asset, so subtracting would mix units.
 */
export function composeVenueEconomics(
  asOf: string,
  period: string,
  revenue: RevenueRead,
  entries: readonly OpsCostEntry[],
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
    net: { status: 'unavailable', reason: 'revenue_asset_unknown' },
  };
}
