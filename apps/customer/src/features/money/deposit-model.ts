import { dec } from '../../data/decimal';

export interface DepositItem {
  id: string;
  kind: string;
  direction: string;
  asset: string;
  amount: string;
  postedAt: string;
}

/** Assets a customer could pay in: what they already hold first, then the listed coins, each once. */
export function depositAssets(held: readonly string[], listed: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const asset of [...held, ...[...listed].sort((a, b) => a.localeCompare(b))]) {
    const key = asset.trim().toUpperCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** The customer's own deposits, newest first. Welcome test funds are shown as what they are, not as a bank deposit. */
export function depositHistory(items: readonly DepositItem[], asset: string | null): DepositItem[] {
  return items
    .filter(
      (item) => (item.kind === 'deposit' || item.kind === 'welcome_funds') && item.direction === 'in' && (!asset || item.asset === asset),
    )
    .sort((a, b) => Date.parse(b.postedAt) - Date.parse(a.postedAt));
}

/** The sum of the shown deposits in one asset, exact. Null when there is nothing to add or the asset mixes. */
export function depositTotal(rows: readonly DepositItem[]): { asset: string; amount: bigint } | null {
  const first = rows[0];
  if (!first || rows.some((row) => row.asset !== first.asset)) return null;
  let total = 0n;
  for (const row of rows) {
    const value = dec(row.amount);
    if (value === null) return null;
    total += value;
  }
  return { asset: first.asset, amount: total };
}
