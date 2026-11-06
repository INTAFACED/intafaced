/**
 * Public funding reads from svc-trade's own tables (J-derivatives-08 #4, #6).
 *
 * - `sqlComputedFundingHistory`: every PUBLISHED computed period of a market, with what its rate was built from and,
 *   once the funding tick settled it, the period's legs: what payers paid and receivers received, summed from the
 *   per-position record of what the ledger was asked to move (`position_funding_applied`). Payers and receivers net
 *   to zero, so the two sums are equal; showing both lets anyone check it.
 * - `sqlFundingSeries`: the latest mark and index samples the rate is computed from.
 *
 * Read only. Amounts are decimal strings; nothing missing becomes zero.
 */
import type { Sql } from 'postgres';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { indexReasonOf, type FundingHistoryRow, type FundingSeriesPoint } from './funding-history.js';
import { annualisedRate, periodLengthSeconds } from './funding-view.js';

function canonical(value: string | null): string | null {
  return value == null ? null : formatAmount(parseAmount(value));
}

export async function sqlComputedFundingHistory(sql: Sql, marketId: string): Promise<FundingHistoryRow[]> {
  const rows = await sql<
    Array<{
      period_id: string;
      period_start: Date;
      period_end: Date;
      rate: string;
      premium: string | null;
      base_component: string | null;
      cap: string | null;
      inputs: Record<string, unknown>;
      leg_count: number | null;
      settled: boolean;
      paid: string | null;
      received: string | null;
    }>
  >`
    SELECT p.period_id, p.period_start, p.period_end, p.rate, p.premium, p.base_component, p.cap, p.inputs,
           s.leg_count, (s.period_id IS NOT NULL) AS settled, a.paid::text AS paid, a.received::text AS received
      FROM trade.funding_rate_periods p
      LEFT JOIN trade.funding_periods s ON s.period_id = p.period_id
      LEFT JOIN LATERAL (
        SELECT coalesce(sum(f.paid) FILTER (WHERE f.paid > 0), 0) AS paid,
               coalesce(-sum(f.paid) FILTER (WHERE f.paid < 0), 0) AS received
          FROM trade.position_funding_applied f
         WHERE f.period_id = p.period_id
      ) a ON true
     WHERE p.market_id = ${marketId} AND p.status = 'published' AND p.rate IS NOT NULL
       AND p.period_start IS NOT NULL AND p.period_end IS NOT NULL
     ORDER BY p.period_start ASC`;
  return rows.map((r) => {
    const startIso = r.period_start.toISOString();
    const endIso = r.period_end.toISOString();
    const text = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : null);
    return {
      marketId,
      periodId: r.period_id,
      periodTimestamp: r.period_start.getTime(),
      fundingRate: r.rate,
      markPrice: text(r.inputs?.closingMark),
      indexPrice: text(r.inputs?.closingIndex),
      premium: r.premium,
      interestComponent: r.base_component,
      cap: r.cap,
      annualisedRate: annualisedRate(r.rate, periodLengthSeconds({ periodStart: startIso, periodEnd: endIso })),
      settlement: r.settled ? { legs: r.leg_count ?? 0, paid: canonical(r.paid) ?? '0', received: canonical(r.received) ?? '0' } : null,
    };
  });
}

export async function sqlFundingSeries(sql: Sql, marketId: string, limit: number): Promise<FundingSeriesPoint[]> {
  const rows = await sql<Array<{ sampled_at: Date; mark: string | null; index_price: string | null; gap_reason: string | null }>>`
    SELECT sampled_at, mark::text, index_price::text, gap_reason
      FROM trade.funding_rate_samples
     WHERE market_id = ${marketId}
     ORDER BY sampled_at DESC
     LIMIT ${limit}`;
  return rows.reverse().map((r) => {
    const index = canonical(r.index_price);
    return {
      at: r.sampled_at.toISOString(),
      mark: canonical(r.mark),
      index,
      indexReason: indexReasonOf(index, r.gap_reason),
    };
  });
}
