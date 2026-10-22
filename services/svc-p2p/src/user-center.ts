/**
 * P2P USER CENTER (P-ads-merchant-20) — own performance and counterparty pay timing.
 *
 * Every number here is recomputed from `p2p.p2p_trades`, never stored as an
 * independent fact, so the user center cannot drift from the order list.
 * Volume is a decimal string per (asset, fiat): money never passes through a
 * JS number. Rates and seconds are counts, not money.
 *
 * No history is honest zeros and null averages. An empty record is not a
 * perfect one, and an average over zero samples is not zero seconds.
 */
import type { Sql } from 'postgres';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';

export interface VolumeRow {
  readonly asset: string;
  readonly fiatCurrency: string;
  /** Sum of released trade amounts in `asset`. Decimal string. */
  readonly amount: string;
  /** Sum of released trade fiat amounts in `fiatCurrency`. Decimal string. */
  readonly fiatAmount: string;
}

export interface OwnStats {
  /** Trades that reached escrow (same denominator as reputation). */
  readonly ordersTotal: number;
  readonly completed: number;
  readonly cancelled: number;
  readonly disputed: number;
  /** completed / ordersTotal to four decimals; 0 with no history. */
  readonly completionRate: number;
  /** escrowed cancellations / ordersTotal to four decimals; 0 with no history. */
  readonly cancelRate: number;
  /** Seller side: escrow lock to release. Null with no sample. */
  readonly avgReleaseSecs: number | null;
  /** Buyer side: escrow lock to "marked paid". Null with no sample. */
  readonly avgPaySecs: number | null;
  readonly volume: VolumeRow[];
}

export function rateOf(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 10_000) / 10_000;
}

function avgOrNull(total: unknown, samples: unknown): number | null {
  const n = Number(samples ?? 0);
  if (n <= 0) return null;
  return Math.round(Number(total) / n);
}

/** Normalise a numeric::text sum ("40.000000000000000000") through the money parser. */
export function decimalSum(raw: string | null | undefined): string {
  return formatAmount(parseAmount(raw ?? '0'));
}

export async function payTiming(sql: Sql, userId: string): Promise<{ avgPaySecs: number | null; paySamples: number }> {
  const rows = await sql<Array<{ total: string | null; n: number }>>`
    SELECT COALESCE(sum(EXTRACT(EPOCH FROM (fiat_sent_at - escrowed_at))), 0)::text AS total,
           count(*)::int AS n
      FROM p2p.p2p_trades
     WHERE buyer_id = ${userId}
       AND escrowed_at IS NOT NULL
       AND fiat_sent_at IS NOT NULL
       AND fiat_sent_at >= escrowed_at
  `;
  const row = rows[0];
  const paySamples = Number(row?.n ?? 0);
  return { avgPaySecs: avgOrNull(row?.total, paySamples), paySamples };
}

export async function ownStats(sql: Sql, userId: string): Promise<OwnStats> {
  const counts = await sql<
    Array<{ total: number; completed: number; cancelled: number; disputed: number; rel_total: string | null; rel_n: number }>
  >`
    SELECT count(*) FILTER (WHERE escrowed_at IS NOT NULL)::int AS total,
           count(*) FILTER (WHERE escrowed_at IS NOT NULL AND status = 'released')::int AS completed,
           count(*) FILTER (WHERE escrowed_at IS NOT NULL AND status = 'cancelled')::int AS cancelled,
           count(*) FILTER (WHERE escrowed_at IS NOT NULL AND status = 'disputed')::int AS disputed,
           COALESCE(sum(EXTRACT(EPOCH FROM (resolved_at - escrowed_at)))
             FILTER (WHERE seller_id = ${userId} AND status = 'released' AND resolved_at IS NOT NULL
                       AND escrowed_at IS NOT NULL AND resolved_at >= escrowed_at), 0)::text AS rel_total,
           count(*) FILTER (WHERE seller_id = ${userId} AND status = 'released' AND resolved_at IS NOT NULL
                              AND escrowed_at IS NOT NULL AND resolved_at >= escrowed_at)::int AS rel_n
      FROM p2p.p2p_trades
     WHERE seller_id = ${userId} OR buyer_id = ${userId}
  `;
  const c = counts[0];
  const total = Number(c?.total ?? 0);
  const completed = Number(c?.completed ?? 0);
  const cancelled = Number(c?.cancelled ?? 0);
  const pay = await payTiming(sql, userId);
  const vol = await sql<Array<{ asset: string; fiat_currency: string; amount: string; fiat_amount: string }>>`
    SELECT asset, fiat_currency, sum(amount)::text AS amount, sum(fiat_amount)::text AS fiat_amount
      FROM p2p.p2p_trades
     WHERE (seller_id = ${userId} OR buyer_id = ${userId}) AND status = 'released'
     GROUP BY asset, fiat_currency
     ORDER BY asset ASC, fiat_currency ASC
  `;
  return {
    ordersTotal: total,
    completed,
    cancelled,
    disputed: Number(c?.disputed ?? 0),
    completionRate: rateOf(completed, total),
    cancelRate: rateOf(cancelled, total),
    avgReleaseSecs: avgOrNull(c?.rel_total, c?.rel_n),
    avgPaySecs: pay.avgPaySecs,
    volume: vol.map((v) => ({
      asset: v.asset,
      fiatCurrency: v.fiat_currency,
      amount: decimalSum(v.amount),
      fiatAmount: decimalSum(v.fiat_amount),
    })),
  };
}
