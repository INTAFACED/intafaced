import { formatAmount, parseAmount } from '../../shared/money';

export type StakeRow = {
  id: string;
  amount: string;
  tier: 'flex' | 'm3' | 'm12';
  startedAt: string;
  unlocksAt: string | null;
  status: 'pending' | 'active' | 'unstaking' | 'closed';
};

/** Lock length per term as the staking service defines it. Flexible stakes have
 * no unlock date. These are terms, not yields: no return is published. */
export const STAKE_LOCK_DAYS: Readonly<Record<StakeRow['tier'], number>> = { flex: 0, m3: 90, m12: 365 };

export type StakeSummary = {
  active: string;
  pending: string;
  unstaking: string;
  closed: string;
  /** Active stake still locked at `now`. */
  locked: string;
  /** Active stake that can leave now (flexible, or its lock has passed). */
  free: string;
  count: number;
};

/** Exact totals from the account's own stake rows. No price, no yield. */
export function summariseStakes(rows: readonly StakeRow[], now: number): StakeSummary {
  const total = { active: 0n, pending: 0n, unstaking: 0n, closed: 0n, locked: 0n, free: 0n };
  for (const row of rows) {
    const amount = parseAmount(row.amount);
    total[row.status] += amount;
    if (row.status === 'active') {
      const unlock = row.unlocksAt ? Date.parse(row.unlocksAt) : null;
      if (unlock !== null && Number.isFinite(unlock) && unlock > now) total.locked += amount;
      else total.free += amount;
    }
  }
  return {
    active: formatAmount(total.active),
    pending: formatAmount(total.pending),
    unstaking: formatAmount(total.unstaking),
    closed: formatAmount(total.closed),
    locked: formatAmount(total.locked),
    free: formatAmount(total.free),
    count: rows.length,
  };
}

export type Unlock = { id: string; amount: string; tier: StakeRow['tier']; unlocksAt: string; daysLeft: number };
const DAY = 86_400_000;
/** Future unlock dates of stakes that still hold value, soonest first. */
export function unlockCalendar(rows: readonly StakeRow[], now: number): Unlock[] {
  return rows
    .filter((row) => row.status !== 'closed' && row.unlocksAt !== null && Date.parse(row.unlocksAt) > now)
    .map((row) => ({
      id: row.id,
      amount: row.amount,
      tier: row.tier,
      unlocksAt: row.unlocksAt!,
      daysLeft: Math.ceil((Date.parse(row.unlocksAt!) - now) / DAY),
    }))
    .sort((a, b) => Date.parse(a.unlocksAt) - Date.parse(b.unlocksAt));
}

export const STAKE_CSV_HEADER = ['stake_id', 'amount', 'term', 'status', 'started_at', 'unlocks_at'] as const;
export function stakeRows(rows: readonly StakeRow[]): string[][] {
  return rows.map((row) => [row.id, row.amount, row.tier, row.status, row.startedAt, row.unlocksAt ?? '']);
}

/** A stake amount typed into the ticket: positive exact decimal only. */
export function validStakeAmount(value: string): boolean {
  if (!/^\d+(\.\d+)?$/.test(value)) return false;
  try {
    return parseAmount(value) > 0n;
  } catch {
    return false;
  }
}
