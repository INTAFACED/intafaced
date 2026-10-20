import { z } from 'zod';
import { dec, str } from './deps';

/** `bank.portfolio.balanceEntries`: the ledger entries behind one coin's spendable balance, newest first, with the sum check. */
export const balanceEntriesSchema = z.object({
  assetId: z.string(),
  entries: z.array(
    z.object({
      entryId: z.string().nullable(),
      txId: z.string(),
      accountId: z.string(),
      reason: z.string(),
      direction: z.enum(['debit', 'credit']),
      amount: z.string(),
      postedAt: z.string(),
    }),
  ),
  nextCursor: z.string().nullable(),
  sumCheck: z.object({ ok: z.literal(true), entriesSum: z.string(), balance: z.string(), entryCount: z.number().int() }),
});

export type BalanceEntriesPage = z.infer<typeof balanceEntriesSchema>;
export type BalanceEntryRow = BalanceEntriesPage['entries'][number];

export const BALANCE_ENTRIES_PAGE = 50;

export const balanceEntriesHref = (asset: string, accountId?: string): string =>
  `/money/balance/${encodeURIComponent(asset)}${accountId && accountId !== 'all' ? `?account=${encodeURIComponent(accountId)}` : ''}`;

export const assetFromPath = (raw: string): string => {
  try {
    return decodeURIComponent(raw).trim().toUpperCase().slice(0, 16);
  } catch {
    return '';
  }
};

/** The account asked for: `main`, a Space id, or null for all of them. Anything else is ignored, never sent. */
export function accountFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get('account');
  return value && (value === 'main' || /^[0-9a-f-]{36}$/i.test(value)) ? value : null;
}

/** Signed amount of an entry: money in is positive, money out negative. Null when the bank's figure does not parse. */
export function signedOf(row: Pick<BalanceEntryRow, 'amount' | 'direction'>): bigint | null {
  const value = dec(row.amount);
  if (value === null) return null;
  return row.direction === 'debit' ? value : -value;
}

/**
 * The sum of the rows shown so far, so the page can say how much of the check it is looking at. Exact (scaled integers).
 * Null if any row does not parse: an unknown figure is never turned into a shown zero.
 */
export function shownSum(rows: readonly BalanceEntryRow[]): string | null {
  let total = 0n;
  for (const row of rows) {
    const value = signedOf(row);
    if (value === null) return null;
    total += value;
  }
  return str(total);
}
