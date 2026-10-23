import { formatAmount, parseAmount } from '@intafaced/ledger-client';

/**
 * Treasury figures already stored by svc-token (MC-token-04).
 *
 * Closed emission epochs, settled buyback runs, and yield payouts that name a
 * ledger transaction. This is not a balance read and not a price. No rows is
 * null. A blank or negative total beside rows is unreadable, never zero.
 */

export interface TokenTreasuryView {
  /** Sum of `mined_amount` on closed epochs. Null when none are closed. */
  readonly minted: string | null;
  /** Sum of `tokens_burned` on settled buyback runs. Null when none are settled. */
  readonly burned: string | null;
  /** Sum of `tokens_bought` on those same settled runs. */
  readonly bought: string | null;
  /** Sum of `tokens_to_rewards` on those same settled runs. */
  readonly toRewards: string | null;
  /** Sum of yield payout amounts that point at a ledger transaction. */
  readonly distributed: string | null;
}

export interface TreasurySums {
  readonly minted: string | null;
  readonly mintedCount: string;
  readonly burned: string | null;
  readonly burnedCount: string;
  readonly bought: string | null;
  readonly boughtCount: string;
  readonly toRewards: string | null;
  readonly toRewardsCount: string;
  readonly distributed: string | null;
  readonly distributedCount: string;
}

export const TREASURY_FIGURE_UNREADABLE = 'token.treasury_figure_unreadable' as const;

export type TreasuryReportResult = { ok: true; view: TokenTreasuryView } | { ok: false; code: typeof TREASURY_FIGURE_UNREADABLE };

const FIGURES = [
  ['minted', 'mintedCount'],
  ['burned', 'burnedCount'],
  ['bought', 'boughtCount'],
  ['toRewards', 'toRewardsCount'],
  ['distributed', 'distributedCount'],
] as const;

function unreadable(): TreasuryReportResult {
  return { ok: false, code: TREASURY_FIGURE_UNREADABLE };
}

/** Canonical decimal, or null when the count is zero. Never a JS number. */
export function reportTreasury(row: TreasurySums): TreasuryReportResult {
  const view: {
    minted: string | null;
    burned: string | null;
    bought: string | null;
    toRewards: string | null;
    distributed: string | null;
  } = { minted: null, burned: null, bought: null, toRewards: null, distributed: null };

  for (const [sumKey, countKey] of FIGURES) {
    const count = row[countKey];
    const sum = row[sumKey];
    if (typeof count !== 'string' || !/^\d+$/.test(count)) return unreadable();
    const n = BigInt(count);
    const blank = sum == null || sum.trim() === '';
    if (n === 0n) {
      if (!blank) return unreadable();
      view[sumKey] = null;
      continue;
    }
    if (blank || sum == null) return unreadable();
    let parsed: bigint;
    try {
      parsed = parseAmount(sum);
    } catch {
      return unreadable();
    }
    if (parsed < 0n) return unreadable();
    view[sumKey] = formatAmount(parsed);
  }

  return { ok: true, view };
}
