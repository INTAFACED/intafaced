import { parseAmount, formatAmount } from '../../../../shared/money';
import type { AssetAmount, Payment, PaymentEvent, Series, Snapshot } from '../schemas';
import {
  DAY_MS,
  utcDay,
  addDays,
  isZeroAmount,
  sortKeys,
  type SortKey,
  dayStart,
  matchesSearch,
  compareAmounts,
  text,
  type PaymentStep,
  historyPayload,
  historyAmount,
} from '../model';

/** The window the 30-day chart asks for: whole UTC days, today included (end is exclusive). */
export function seriesWindow(now: Date, days = 30): { from: string; to: string } {
  const today = utcDay(now);
  return { from: `${addDays(today, -(days - 1))}T00:00:00.000Z`, to: `${addDays(today, 1)}T00:00:00.000Z` };
}

export const hasActivity = (snapshot: Snapshot) =>
  snapshot.paymentCount > 0 ||
  snapshot.captured.length > 0 ||
  snapshot.balances.some((b) => !isZeroAmount(b.available) || !isZeroAmount(b.clearing));

export const seriesAssets = (series: Series) => [...new Set(series.points.map((p) => p.assetCode))].sort();
/** The asset with the most volume in the series, which the chart opens on; ties and an empty series fall back to the first by name. */
export function largestAsset(series: Series): string | undefined {
  const totals = new Map<string, number>();
  for (const p of series.points) totals.set(p.assetCode, (totals.get(p.assetCode) ?? 0) + Number(p.volume));
  return seriesAssets(series).sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0))[0];
}

/** Share of payments in each status, as whole-number percentages that are only used to size a bar. */
export function mixShares(mix: Snapshot['statusMix']): Array<{ status: string; count: number; pct: number }> {
  const total = mix.reduce((n, row) => n + row.count, 0);
  return mix.filter((row) => row.count > 0).map((row) => ({ ...row, pct: total === 0 ? 0 : Math.round((row.count / total) * 100) }));
}

export function nextDueSoonest<T extends { responseDueAt: string | null }>(rows: readonly T[]): T | null {
  const dated = rows.filter((r) => r.responseDueAt !== null).sort((a, b) => Date.parse(a.responseDueAt!) - Date.parse(b.responseDueAt!));
  return dated[0] ?? null;
}

export const readSort = (raw: string): SortKey => ((sortKeys as readonly string[]).includes(raw) ? (raw as SortKey) : 'newest');

export type PaymentFilters = { q: string; asset: string; from: string; to: string };

export function filterPayments(rows: readonly Payment[], f: PaymentFilters): Payment[] {
  const from = dayStart(f.from);
  const to = dayStart(f.to);
  return rows.filter((row) => {
    if (f.asset && row.assetId !== f.asset) return false;
    const at = Date.parse(row.createdAt);
    if (from !== null && at < from) return false;
    if (to !== null && at >= to + DAY_MS) return false;
    return matchesSearch([row.id, row.railRef, row.method, row.railAdapter], f.q);
  });
}

export function sortRows<T>(rows: readonly T[], sort: SortKey, at: (row: T) => string, amountOf: (row: T) => string): T[] {
  const out = [...rows];
  const byTime = (a: T, b: T) => Date.parse(at(a)) - Date.parse(at(b));
  switch (sort) {
    case 'newest':
      return out.sort((a, b) => byTime(b, a));
    case 'oldest':
      return out.sort(byTime);
    case 'largest':
      return out.sort((a, b) => compareAmounts(amountOf(b), amountOf(a)) || byTime(b, a));
    case 'smallest':
      return out.sort((a, b) => compareAmounts(amountOf(a), amountOf(b)) || byTime(b, a));
  }
}

/**
 * Of the payments that finished, the share that went through: succeeded / (succeeded + failed). A payment that is
 * still being made (created, authorised) has not finished, so it counts for neither side. `null` when nothing has
 * finished: no finished payments is not a 100% rate.
 */
export function successRate(mix: Snapshot['statusMix']): { total: number; succeeded: number; failed: number; pct: number | null } {
  const sum = (statuses: readonly string[]) => mix.filter((row) => statuses.includes(row.status)).reduce((n, row) => n + row.count, 0);
  const succeeded = sum(['captured', 'settled', 'refunded', 'disputed']);
  const failed = sum(['failed']);
  const total = succeeded + failed;
  return { total, succeeded, failed, pct: total === 0 ? null : Math.round((succeeded * 100) / total) };
}

export const countOf = (mix: Snapshot['statusMix'], status: string) => mix.find((row) => row.status === status)?.count ?? 0;

/** What can still be refunded: captured minus refunded, never below zero. */
export function refundable(payment: Pick<Payment, 'capturedAmount' | 'refundedAmount'>): string {
  const left = parseAmount(payment.capturedAmount) - parseAmount(payment.refundedAmount);
  return formatAmount(left > 0n ? left : 0n);
}

export function paymentSteps(events: readonly PaymentEvent[]): PaymentStep[] {
  const out: PaymentStep[] = [];
  for (const e of events) {
    const kind = (
      {
        created: 'created',
        authorized: 'authorized',
        captured: 'captured',
        settled: 'settled',
        refunded: 'refunded',
        'refund.reversed': 'refund_reversed',
        disputed: 'disputed',
        failed: 'failed',
        'payer_name.held': 'held_name',
      } as const
    )[e.event as 'created'];
    if (!kind) continue;
    const payload = historyPayload(e);
    out.push({
      at: e.ts,
      kind,
      amount: historyAmount(e),
      refundId: text(payload.refundId),
      settlementId: text(payload.settlementId),
    });
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export type SeriesTotal = { assetCode: string; count: number; volume: string };
/** Sum a customer's daily points from `sinceDay` (YYYY-MM-DD, inclusive), one line per asset. Assets are never added together. */
export function seriesTotals(
  items: ReadonlyArray<{ period: string; assetCode: string; count: number; volume: string }>,
  sinceDay: string,
): SeriesTotal[] {
  const by = new Map<string, { count: number; volume: bigint }>();
  for (const i of items) {
    if (i.period < sinceDay) continue;
    const cur = by.get(i.assetCode) ?? { count: 0, volume: 0n };
    by.set(i.assetCode, { count: cur.count + i.count, volume: cur.volume + parseAmount(i.volume) });
  }
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([assetCode, v]) => ({ assetCode, count: v.count, volume: formatAmount(v.volume) }));
}

/**
 * What was refunded inside a window, one line per asset, summed exactly. A refund the network turned back is not money
 * given back, so it is left out. Two assets are never added together.
 */
export function refundsIssuedTotals(rows: ReadonlyArray<{ amount: string; assetId: string; status: string }>): AssetAmount[] {
  const by = new Map<string, bigint>();
  for (const row of rows) {
    if (row.status === 'reversed') continue;
    by.set(row.assetId, (by.get(row.assetId) ?? 0n) + parseAmount(row.amount));
  }
  return [...by.entries()]
    .filter(([, total]) => total > 0n)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([assetCode, total]) => ({ assetCode, amount: formatAmount(total) }));
}
