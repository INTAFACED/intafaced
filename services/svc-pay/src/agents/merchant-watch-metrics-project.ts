import type postgres from 'postgres';
import type { MerchantWatchMetricPoint } from './merchant-watch-metrics-store.js';

/** Rolling window for payment-derived approval samples (24h). */
export const PAY_MERCHANT_WATCH_PROJECT_WINDOW_MS = 86_400_000 as const;

type PaymentAggRow = {
  rail_id: string;
  success_count: number;
  failed_count: number;
  as_of: Date;
};

/** Format success / (success + failed) as a decimal string — never a JS money amount. */
export function formatApprovalRate(success: number, failed: number): string | null {
  const attempts = success + failed;
  if (attempts <= 0) return null;
  return (success / attempts).toFixed(4);
}

export async function listProjectedPayMetrics(
  sql: postgres.Sql,
  windowMs: number = PAY_MERCHANT_WATCH_PROJECT_WINDOW_MS,
): Promise<readonly MerchantWatchMetricPoint[]> {
  const rows = await sql<PaymentAggRow[]>`
    SELECT
      rail_adapter AS rail_id,
      COUNT(*) FILTER (WHERE status IN ('captured', 'settled'))::int AS success_count,
      COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count,
      MAX(updated_at) AS as_of
    FROM pay.payments
    WHERE updated_at >= now() - ${`${windowMs} milliseconds`}::interval
      AND status IN ('captured', 'settled', 'failed')
    GROUP BY rail_adapter
    HAVING COUNT(*) > 0
    ORDER BY rail_adapter
  `;

  const asOf = new Date().toISOString();
  const points: MerchantWatchMetricPoint[] = [];
  for (const row of rows) {
    const attempts = row.success_count + row.failed_count;
    if (attempts <= 0) continue;
    points.push({
      railId: row.rail_id,
      approvalRate: formatApprovalRate(row.success_count, row.failed_count),
      attempts,
      asOf: row.as_of?.toISOString() ?? asOf,
      maxAgeMs: windowMs,
    });
  }
  return points;
}
