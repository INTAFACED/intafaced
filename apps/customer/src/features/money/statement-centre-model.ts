/** What a statement file holds (svc-bank `bank.statements.export` `report`, PF-statements-01). */
export const STATEMENT_REPORTS = ['statement', 'ledger', 'trades', 'balances'] as const;
export type StatementReport = (typeof STATEMENT_REPORTS)[number];

/** A UTC day as "YYYY-MM-DD". */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** The last 30 UTC days, today included, as the date fields show them. */
export function last30Days(now: Date): { from: string; to: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 29));
  return { from: utcDay(start), to: utcDay(now) };
}

/**
 * Two UTC days to the first millisecond of the first and the last millisecond of the second, or null when either is not a
 * real day or the end is before the start. The bank refuses a range over 366 days and a PDF over two months itself.
 */
export function dayRange(from: string, to: string): { from: string; to: string } | null {
  const start = dayStart(from);
  const end = dayStart(to);
  if (start === null || end === null || end < start) return null;
  return { from: new Date(start).toISOString(), to: new Date(end + 86_400_000 - 1).toISOString() };
}

function dayStart(day: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  const at = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return utcDay(new Date(at)) === day ? at : null;
}
