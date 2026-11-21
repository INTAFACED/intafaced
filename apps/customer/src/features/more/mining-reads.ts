import type { ProcedureOutput } from '@intafaced/contracts/procedure';
import type {
  MINING_PAYOUTS_MINE,
  MINING_POW,
  MINING_SHARES_MINE,
  MINING_TERMS,
  MINING_WINDOWS_PENDING,
  MINING_WORKERS_MINE,
} from '@intafaced/contracts/mining-procedures';
import { formatAmount, parseAmount } from '../../shared/money';

/**
 * The customer-scoped reads the mining pool publishes behind `/api/mining/trpc` (own account only, `ledger:read`). Their
 * shapes are the records' (`@intafaced/contracts/mining-procedures`). Figures stay exact decimal strings; nothing here turns
 * a weight into a rate or a share into a reward.
 */

export const WINDOW_MINUTES = [15, 60, 1440] as const;
export type WindowMinutes = (typeof WINDOW_MINUTES)[number];
export const PAYOUT_PAGE = 20;
/** One page of the worker roster. */
export const WORKER_PAGE = 20;
export const WORKER_MODES = ['pooled', 'solo'] as const;
export type WorkerMode = (typeof WORKER_MODES)[number];
export const MODE_CHANGE_IN_WINDOW = 'mining.mode_change_in_window';
export const EMISSION_UNPUBLISHED = 'mining.emission_unpublished';

export type MinerWorkers = ProcedureOutput<typeof MINING_WORKERS_MINE>;
/** The pool's proof-of-work parameters: a TEST testnet set, or blank with its code. A mainnet set is never served. */
export type PowSpec = ProcedureOutput<typeof MINING_POW>;
export type MinerShares = ProcedureOutput<typeof MINING_SHARES_MINE>;
export type PendingWindows = ProcedureOutput<typeof MINING_WINDOWS_PENDING>;
export type PayoutPage = ProcedureOutput<typeof MINING_PAYOUTS_MINE>;
export type PoolTerms = ProcedureOutput<typeof MINING_TERMS>;

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
