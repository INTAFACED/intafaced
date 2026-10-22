/**
 * P2P COMPLETION RATE, 30-DAY AND TOTAL (P-trade-orders-21).
 *
 * Recomputed from `p2p.p2p_trades` on every read. The definition is data
 * (`COMPLETION_DEFINITION`), so the popover text and the SQL cannot disagree
 * silently: both live here.
 *
 * Rates go on the wire as decimal-string percents with two places ("95.24").
 * No counted order is null (no rate), never "0.00" or "100.00".
 */
import type { Sql } from 'postgres';

export const COMPLETION_DEFINITION = {
  numerator: 'Orders released (completed), including releases by a dispute ruling.',
  denominator:
    'Orders that reached escrow and have an outcome: completed, cancelled after escrow, or disputed. ' +
    'Orders still in progress, orders cancelled before escrow, and an order excluded by an accepted appeal do not count.',
  window30d: 'Orders created in the last 30 days.',
  noHistory: 'No order has reached an outcome in this window, so there is no rate (shown as a dash, not 0%).',
} as const;

/**
 * part/whole as a percent string with two decimals, computed in integers (no
 * float). Null when nothing is counted: no finished order is not 0% completed.
 */
export function percentString(part: number, whole: number): string | null {
  if (whole <= 0) return null;
  // basis points of a percent, rounded half up: part * 10000 / whole
  const bp = Math.floor((part * 10_000 * 2 + whole) / (whole * 2));
  const s = String(bp).padStart(3, '0');
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}

export interface CompletionRates {
  readonly completionRate30d: string | null;
  readonly completionRateTotal: string | null;
  readonly completed30d: number;
  readonly counted30d: number;
  readonly completedTotal: number;
  readonly countedTotal: number;
}

export async function completionRates(sql: Sql, userId: string): Promise<CompletionRates> {
  const rows = await sql<Array<{ c30: number; n30: number; ct: number; nt: number }>>`
    SELECT count(*) FILTER (WHERE t.status = 'released' AND t.created_at >= now() - interval '30 days')::int AS c30,
           count(*) FILTER (WHERE t.created_at >= now() - interval '30 days')::int AS n30,
           count(*) FILTER (WHERE t.status = 'released')::int AS ct,
           count(*)::int AS nt
      FROM p2p.p2p_trades t
     WHERE (t.seller_id = ${userId} OR t.buyer_id = ${userId})
       AND t.escrowed_at IS NOT NULL
       AND t.status IN ('released', 'cancelled', 'disputed')
       AND NOT EXISTS (
         SELECT 1 FROM p2p.completion_appeals a
          WHERE a.user_id = ${userId} AND a.trade_id = t.id AND a.status = 'accepted'
       )
  `;
  const r = rows[0];
  const c30 = Number(r?.c30 ?? 0);
  const n30 = Number(r?.n30 ?? 0);
  const ct = Number(r?.ct ?? 0);
  const nt = Number(r?.nt ?? 0);
  return {
    completionRate30d: percentString(c30, n30),
    completionRateTotal: percentString(ct, nt),
    completed30d: c30,
    counted30d: n30,
    completedTotal: ct,
    countedTotal: nt,
  };
}

export type AppealStatus = 'available' | 'submitted' | 'accepted' | 'rejected';

export interface AppealRecord {
  readonly id: string;
  readonly userId: string;
  readonly tradeId: string;
  readonly reason: string;
  readonly status: 'submitted' | 'accepted' | 'rejected';
  readonly submittedAt: string;
  readonly reviewDueAt: string;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly decisionReason: string | null;
}

export interface AppealRow {
  id: string;
  user_id: string;
  trade_id: string;
  reason: string;
  status: 'submitted' | 'accepted' | 'rejected';
  submitted_at: Date;
  review_due_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
}

export function toAppeal(r: AppealRow): AppealRecord {
  return {
    id: r.id,
    userId: r.user_id,
    tradeId: r.trade_id,
    reason: r.reason,
    status: r.status,
    submittedAt: r.submitted_at.toISOString(),
    reviewDueAt: r.review_due_at.toISOString(),
    decidedBy: r.decided_by,
    decidedAt: r.decided_at?.toISOString() ?? null,
    decisionReason: r.decision_reason,
  };
}
