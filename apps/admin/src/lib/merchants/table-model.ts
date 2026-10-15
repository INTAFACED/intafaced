import { buildCsv } from './csv';
import { compareDecimal, amountFor, type AssetAmount } from './money';

/** One merchant row as `founderAdmin.merchants.list` returns it. */
export interface MerchantRow {
  readonly merchantId: string;
  readonly status: string;
  readonly tierId: string | null;
  readonly kybStatus: string;
  readonly volume: readonly AssetAmount[];
  readonly revenue: readonly AssetAmount[];
  readonly openFlags: number;
}

export type SortKey = 'merchantId' | 'status' | 'kybStatus' | 'volume' | 'revenue' | 'openFlags';
export type SortDir = 'asc' | 'desc';
export const SORT_KEYS: readonly SortKey[] = ['merchantId', 'status', 'kybStatus', 'volume', 'revenue', 'openFlags'];

/** Case-insensitive match on the id, status and KYB text. Applies to the rows already loaded. */
export function filterRows(rows: readonly MerchantRow[], query: string): MerchantRow[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...rows];
  return rows.filter((row) => [row.merchantId, row.status, row.kybStatus, row.tierId ?? ''].some((v) => v.toLowerCase().includes(q)));
}

/**
 * Sort the loaded rows. Money columns sort by one asset (never across assets);
 * a row with nothing in that asset sorts last in either direction, because
 * "no payments" is not the smallest amount.
 */
export function sortRows(rows: readonly MerchantRow[], key: SortKey, dir: SortDir, assetCode: string | null): MerchantRow[] {
  const sign = dir === 'asc' ? 1 : -1;
  const out = [...rows];
  out.sort((a, b) => {
    if (key === 'volume' || key === 'revenue') {
      const x = assetCode === null ? null : amountFor(a[key], assetCode);
      const y = assetCode === null ? null : amountFor(b[key], assetCode);
      if (x === null && y === null) return a.merchantId < b.merchantId ? -1 : 1;
      if (x === null) return 1;
      if (y === null) return -1;
      const c = compareDecimal(x, y);
      return c !== 0 ? c * sign : a.merchantId < b.merchantId ? -1 : 1;
    }
    const x = a[key];
    const y = b[key];
    if (x === y) return a.merchantId < b.merchantId ? -1 : 1;
    return (x < y ? -1 : 1) * sign;
  });
  return out;
}

export function assetsIn(rows: readonly MerchantRow[]): string[] {
  const set = new Set<string>();
  for (const row of rows) for (const a of [...row.volume, ...row.revenue]) set.add(a.assetCode);
  return [...set].sort();
}

const perAsset = (rows: readonly AssetAmount[]): string => rows.map((r) => `${r.amount} ${r.assetCode}`).join('; ');

export const CSV_HEADER = ['merchant_id', 'status', 'kyb_status', 'tier', 'lifetime_volume', 'lifetime_revenue', 'open_flags'] as const;

/** CSV of exactly the rows on screen. Amounts are the original decimal strings. */
export function rowsToCsv(rows: readonly MerchantRow[], generatedAt: string, asOf: string | null, filterNote: string): string {
  return buildCsv({
    header: CSV_HEADER,
    rows: rows.map((r) => [
      r.merchantId,
      r.status,
      r.kybStatus,
      r.tierId ?? '',
      perAsset(r.volume),
      perAsset(r.revenue),
      String(r.openFlags),
    ]),
    generatedAt,
    asOf,
    note: `Visible list only. ${filterNote}`,
  });
}
