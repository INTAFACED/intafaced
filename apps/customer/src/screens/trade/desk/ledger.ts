import { formatAmount, parseAmount } from '../../../shared/money';
import type { LedgerEntry } from '../../../features/trade/trade-api';

/**
 * The ledger tab's arithmetic. A line is one balance change on the person's free balance in one asset; "in" adds to it,
 * "out" takes from it. With every line read (no next page), the lines of one asset add up to that asset's available
 * balance, which is how the tab proves it shows every change.
 */

export type LedgerKindKey =
  | 'Ledger kind fill'
  | 'Ledger kind fee'
  | 'Ledger kind hold'
  | 'Ledger kind amend'
  | 'Ledger kind release'
  | 'Ledger kind deposit'
  | 'Ledger kind withdrawal'
  | 'Ledger kind reward'
  | 'Ledger kind other';

/** The words for a ledger line's kind; anything else reads "Other" rather than a service code. */
const KINDS: Record<string, LedgerKindKey> = {
  'trade.fill': 'Ledger kind fill',
  'trade.fill.mm_maker': 'Ledger kind fill',
  // A maker's sale to the token buyback (ledger-client recipes/buyback.ts `buybackTakerFill`).
  'trade.fill.buyback': 'Ledger kind fill',
  'trade.fee': 'Ledger kind fee',
  'order.hold': 'Ledger kind hold',
  'order.hold.amend': 'Ledger kind amend',
  'order.hold.released': 'Ledger kind release',
  'campaigns.task.reward': 'Ledger kind reward',
};
export function ledgerKindKey(e: Pick<LedgerEntry, 'type'>): LedgerKindKey {
  const known = KINDS[e.type];
  if (known) return known;
  if (e.type.startsWith('deposit')) return 'Ledger kind deposit';
  if (e.type.startsWith('withdraw')) return 'Ledger kind withdrawal';
  return 'Ledger kind other';
}

/** Each asset's sum of the lines read, as a decimal string; a signed sum (out more than in reads negative). */
export function sumByAsset(entries: readonly LedgerEntry[]): Map<string, string> {
  const sums = new Map<string, bigint>();
  for (const e of entries) {
    const amount = parseAmount(e.amount);
    sums.set(e.currency, (sums.get(e.currency) ?? 0n) + (e.direction === 'in' ? amount : -amount));
  }
  return new Map([...sums].sort(([a], [b]) => a.localeCompare(b)).map(([asset, sum]) => [asset, formatAmount(sum)]));
}

/** Whether a sum of lines is the balance: compared as amounts, so "1.50" and "1.5" agree. */
export function sameAmount(a: string, b: string): boolean {
  return parseAmount(a) === parseAmount(b);
}

/** "2026-10-01" (a UTC day) to its first instant; null when it is not a real day. */
export function dayStart(day: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const at = new Date(`${day}T00:00:00.000Z`);
  return Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== day ? null : at;
}

export type StatementRange = { from: string; to: string; requestKey: string; endsToday: boolean };

const DAY_MS = 24 * 60 * 60 * 1000;
/** The service lists a range only once it has been over this long (svc-trade STATEMENT_SETTLE_MS). */
const SETTLE_MS = 60_000;

/** Where a statement that includes today ends: the last whole minute that has been over for the settling time. */
export function todayEnd(asOf: Date): Date {
  return new Date(Math.floor((asOf.getTime() - SETTLE_MS) / 60_000) * 60_000);
}

/**
 * The range a statement covers for the days picked, both included, in UTC: from the first day's start to the start of
 * the day after the last. When the last day is today, the range ends at `todayEnd(asOf)` instead (from the moment the
 * person opened the statement, so asking twice from the same dialog is the same range), because the service lists only
 * time that has been over for a minute.
 * The request key is the range itself, so the same range is the same job.
 */
export function statementRange(
  fromDay: string,
  toDay: string,
  asOf: Date,
): { ok: true; range: StatementRange } | { ok: false; why: 'days' | 'order' | 'future' } {
  const start = dayStart(fromDay);
  const last = dayStart(toDay);
  if (!start || !last) return { ok: false, why: 'days' };
  if (last < start) return { ok: false, why: 'order' };
  const dayAfter = new Date(last.getTime() + DAY_MS);
  const minute = todayEnd(asOf);
  if (last > minute) return { ok: false, why: 'future' };
  const endsToday = dayAfter > minute;
  const end = endsToday ? minute : dayAfter;
  if (end <= start) return { ok: false, why: 'future' };
  const to = end.toISOString();
  return {
    ok: true,
    range: {
      from: start.toISOString(),
      to,
      requestKey: endsToday ? `statement:${fromDay}:${to}` : `statement:${fromDay}:${toDay}`,
      endsToday,
    },
  };
}

/** The SHA-256 of a text, as lowercase hex, to check a downloaded file is the one the job fingerprinted. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
