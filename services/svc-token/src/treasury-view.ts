import { formatAmount, parseAmount } from '@intafaced/ledger-client';

/**
 * Treasury figures (MC-token-04).
 *
 * Lifetime `minted`, `bought`, `toRewards` and `distributed` are closed
 * emission epochs, settled buyback runs, and yield payouts that name a ledger
 * transaction. `burned` is not one of those sums: the service fills it from
 * `burnedSupply` so it cannot be a second burn total. `lastBuyback` is the
 * latest settled run. No rows is null. A blank or negative total beside rows
 * is unreadable, never zero. This fold does not price the token.
 */

export interface LastBuyback {
  readonly bought: string;
  readonly burned: string;
  readonly toRewards: string;
  readonly executedAt: string;
}

export interface TreasurySumView {
  /** Sum of `mined_amount` on closed epochs. Null when none are closed. */
  readonly minted: string | null;
  /** Sum of `tokens_bought` on settled buyback runs. Null when none are settled. */
  readonly bought: string | null;
  /** Sum of `tokens_to_rewards` on those same settled runs. */
  readonly toRewards: string | null;
  /** Sum of yield payout amounts that point at a ledger transaction. */
  readonly distributed: string | null;
}

export interface TokenTreasuryView extends TreasurySumView {
  /** `burnedSupply` — the burn-account balance, not the buyback sum. */
  readonly burned: string;
  /** Latest settled buyback run. Null when none are settled. */
  readonly lastBuyback: LastBuyback | null;
}

export interface TreasurySums {
  readonly minted: string | null;
  readonly mintedCount: string;
  readonly bought: string | null;
  readonly boughtCount: string;
  readonly toRewards: string | null;
  readonly toRewardsCount: string;
  readonly distributed: string | null;
  readonly distributedCount: string;
}

export interface LastBuybackRow {
  readonly bought: string | null;
  readonly burned: string | null;
  readonly toRewards: string | null;
  readonly executedAt: Date | string | null;
}

export const TREASURY_FIGURE_UNREADABLE = 'token.treasury_figure_unreadable' as const;

export type TreasuryReportResult = { ok: true; view: TreasurySumView } | { ok: false; code: typeof TREASURY_FIGURE_UNREADABLE };

export type LastBuybackResult = { ok: true; last: LastBuyback | null } | { ok: false; code: typeof TREASURY_FIGURE_UNREADABLE };

const FIGURES = [
  ['minted', 'mintedCount'],
  ['bought', 'boughtCount'],
  ['toRewards', 'toRewardsCount'],
  ['distributed', 'distributedCount'],
] as const;

function unreadable(): { ok: false; code: typeof TREASURY_FIGURE_UNREADABLE } {
  return { ok: false, code: TREASURY_FIGURE_UNREADABLE };
}

function blank(value: string | null | undefined): boolean {
  return value == null || value.trim() === '';
}

/** Canonical decimal, or null when the count is zero. Never a JS number. */
export function reportTreasury(row: TreasurySums): TreasuryReportResult {
  const view: {
    minted: string | null;
    bought: string | null;
    toRewards: string | null;
    distributed: string | null;
  } = { minted: null, bought: null, toRewards: null, distributed: null };

  for (const [sumKey, countKey] of FIGURES) {
    const count = row[countKey];
    const sum = row[sumKey];
    if (typeof count !== 'string' || !/^\d+$/.test(count)) return unreadable();
    const n = BigInt(count);
    if (n === 0n) {
      if (!blank(sum)) return unreadable();
      view[sumKey] = null;
      continue;
    }
    const canonical = readAmount(sum);
    if (canonical === 'blank' || canonical === 'bad') return unreadable();
    view[sumKey] = canonical;
  }

  return { ok: true, view };
}

/**
 * One settled run, or null when every field is absent (no settled row).
 * A partial or unreadable run is not turned into zeros.
 */
export function reportLastBuyback(row: LastBuybackRow | null): LastBuybackResult {
  if (row == null) return { ok: true, last: null };
  const bought = readAmount(row.bought);
  const burned = readAmount(row.burned);
  const toRewards = readAmount(row.toRewards);
  const executedAt = canonicalInstant(row.executedAt);
  const amounts = [bought, burned, toRewards];
  if (amounts.every((value) => value === 'blank') && executedAt == null && instantAbsent(row.executedAt)) {
    return { ok: true, last: null };
  }
  if (executedAt == null || amounts.some((value) => value === 'blank' || value === 'bad')) return unreadable();
  return { ok: true, last: { bought, burned, toRewards, executedAt } };
}

/** A blank total is missing. A negative or non-decimal total is unreadable, not zero. */
function readAmount(sum: string | null): 'blank' | 'bad' | string {
  if (blank(sum) || sum == null) return 'blank';
  let parsed: bigint;
  try {
    parsed = parseAmount(sum);
  } catch {
    return 'bad';
  }
  if (parsed < 0n) return 'bad';
  return formatAmount(parsed);
}

function instantAbsent(value: Date | string | null): boolean {
  if (value == null) return true;
  if (typeof value === 'string') return value.trim() === '';
  return false;
}

function canonicalInstant(value: Date | string | null): string | null {
  if (instantAbsent(value) || value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  if (ms !== ms) return null;
  return date.toISOString();
}

export interface BuybackRunView {
  readonly id: string;
  readonly bought: string;
  readonly burned: string;
  readonly toRewards: string;
  readonly executedAt: string;
  readonly windowFrom: string;
  readonly windowTo: string;
}

export interface BuybackRunRow {
  readonly id: string | null;
  readonly bought: string | null;
  readonly burned: string | null;
  readonly toRewards: string | null;
  readonly executedAt: Date | string | null;
  readonly windowFrom: Date | string | null;
  readonly windowTo: Date | string | null;
}

export type BuybackRunsResult = { ok: true; runs: BuybackRunView[] } | { ok: false; code: typeof TREASURY_FIGURE_UNREADABLE };

/**
 * Settled buyback runs as stored. Every field must read, and each run must
 * add up: bought = burned + toRewards (what `splitBuyback` wrote). A run that
 * does not is unreadable — the page never shows a row that fails its own sum.
 */
export function reportBuybackRuns(rows: readonly BuybackRunRow[]): BuybackRunsResult {
  const runs: BuybackRunView[] = [];
  for (const row of rows) {
    const bought = readAmount(row.bought);
    const burned = readAmount(row.burned);
    const toRewards = readAmount(row.toRewards);
    const executedAt = canonicalInstant(row.executedAt);
    const windowFrom = canonicalInstant(row.windowFrom);
    const windowTo = canonicalInstant(row.windowTo);
    if (blank(row.id) || row.id == null) return unreadable();
    if (executedAt == null || windowFrom == null || windowTo == null) return unreadable();
    if ([bought, burned, toRewards].some((value) => value === 'blank' || value === 'bad')) return unreadable();
    if (parseAmount(bought) !== parseAmount(burned) + parseAmount(toRewards)) return unreadable();
    runs.push({ id: row.id, bought, burned, toRewards, executedAt, windowFrom, windowTo });
  }
  return { ok: true, runs };
}
