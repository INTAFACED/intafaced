import { z } from 'zod';
import { formatAmount, parseAmount } from '../../shared/money';

/**
 * The customer-scoped reads the mining pool publishes behind `/api/mining/trpc` (own account only, `ledger:read`).
 * Figures stay exact decimal strings; nothing here turns a weight into a rate or a share into a reward.
 */
const decimal = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/);

export const WINDOW_MINUTES = [15, 60, 1440] as const;
export type WindowMinutes = (typeof WINDOW_MINUTES)[number];
export const PAYOUT_PAGE = 20;

export const minerWorkers = z.object({
  asOf: z.string(),
  windowMinutes: z.number().int(),
  workers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      createdAt: z.string(),
      hashrate: decimal.nullable(),
      hashrateReason: z.string().nullable(),
      minDifficulty: decimal.nullable(),
    }),
  ),
  defaultDifficulty: decimal.nullable(),
  defaultDifficultyReason: z.string().nullable(),
  nextCursor: z.string().nullable(),
});
/** One page of the worker roster. */
export const WORKER_PAGE = 20;
export const workerDifficulty = z.object({ id: z.string(), minDifficulty: decimal.nullable() });
export type MinerWorkers = z.infer<typeof minerWorkers>;

export const minerShares = z.object({
  asOf: z.string(),
  windows: z.array(
    z.object({
      windowId: z.string(),
      acceptedCount: z.number().int().nonnegative(),
      rejectedCount: z.number().int().nonnegative(),
      acceptedWeight: decimal.nullable(),
    }),
  ),
});
export type MinerShares = z.infer<typeof minerShares>;

export const pendingWindows = z.object({
  asOf: z.string(),
  windows: z.array(
    z.object({
      windowId: z.string(),
      assetId: z.string(),
      callerWeight: decimal,
      totalWeight: decimal.nullable(),
      reward: decimal.nullable(),
      feeBps: z.number().int().nullable(),
      estimate: z.object({ estimate: z.literal(true), estimatedGross: decimal }).nullable(),
    }),
  ),
});
export type PendingWindows = z.infer<typeof pendingWindows>;

export const payoutPage = z.object({
  asOf: z.string(),
  nextCursor: z.string().nullable(),
  payouts: z.array(
    z.object({
      windowId: z.string(),
      minerId: z.string(),
      assetId: z.string(),
      amount: decimal.nullable(),
      amountReason: z.string().nullable(),
      paidAt: z.string().nullable(),
      ledgerTransactionId: z.string().nullable(),
      ledgerReason: z.string().nullable(),
    }),
  ),
});
export type PayoutPage = z.infer<typeof payoutPage>;

export const poolTerms = z.object({
  feeBps: z.number().int().nullable(),
  feeReason: z.string().nullable(),
  windowSize: z.number().int().nullable(),
  windowSizeReason: z.string().nullable(),
});
export type PoolTerms = z.infer<typeof poolTerms>;

/** Exact sum of whole-number share weights. Null when any weight is not a whole number, so nothing is rounded. */
export function sumWeights(values: readonly (string | null)[]): string | null {
  let total = 0n;
  for (const value of values) {
    if (value === null) continue;
    if (!/^\d+$/.test(value)) return null;
    total += BigInt(value);
  }
  return total.toString();
}

/** Exact sums per asset, in first-seen order. An amount that is not a ledger amount is skipped, never rounded. */
export function sumByAsset(rows: readonly { assetId: string; amount: string | null }[]): { assetId: string; amount: string }[] {
  const totals = new Map<string, bigint>();
  for (const row of rows) {
    if (row.amount === null) continue;
    try {
      totals.set(row.assetId, (totals.get(row.assetId) ?? 0n) + parseAmount(row.amount));
    } catch {
      continue;
    }
  }
  return [...totals].map(([assetId, amount]) => ({ assetId, amount: formatAmount(amount) }));
}

/** Basis points as an exact percent string: 50 -> "0.5", 1000 -> "10", 25 -> "0.25". */
export function bpsToPercent(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const fraction = String(bps % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}
