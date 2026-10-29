import { toCsv } from '../../../more/depth-csv';

/** One transaction of the connected address, as the indexer's address read returns it. */
export interface AddressTx {
  hash: string;
  blockHeight: number | null;
  timestamp: number | null;
  from: string;
  to: string | null;
  status: 'success' | 'failed' | 'pending';
  token: { address: string; symbol: string; decimals: number } | null;
  /** Decimal string; null when the transaction moved no token. */
  amount: string | null;
  direction: 'in' | 'out' | 'self';
}

export interface ActivityFilter {
  hideFailed: boolean;
}

/** The rows the table shows: a view filter only, the list itself is never changed. */
export function visibleRows(rows: readonly AddressTx[], filter: ActivityFilter): AddressTx[] {
  return rows.filter((row) => !(filter.hideFailed && row.status === 'failed'));
}

export const CSV_HEADER = ['time', 'hash', 'direction', 'from', 'to', 'token', 'amount', 'status'] as const;

/** The export of exactly the rows shown, in the order shown. */
export function activityCsv(rows: readonly AddressTx[]): string {
  return toCsv(
    CSV_HEADER,
    rows.map((row) => [
      row.timestamp === null ? '' : new Date(row.timestamp * 1000).toISOString(),
      row.hash,
      row.direction,
      row.from,
      row.to ?? '',
      row.token?.symbol ?? '',
      row.amount ?? '',
      row.status,
    ]),
  );
}
