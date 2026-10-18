import type { Sql } from 'postgres';
import type { MerchantAreaFence } from '../merchant-ownership.js';
import type { PayService } from '../payment-service.js';
import { createMerchantMetricsAuthority, type MerchantMetricsAuthority } from './authority.js';
import { MetricsProjector } from './projector.js';
import { MetricsReader, type BalanceReader, type RailHealthRow } from './reader.js';

export interface MetricsRuntime {
  readonly reader: MetricsReader;
  readonly projector: MetricsProjector;
  readonly authority: MerchantMetricsAuthority;
}

export interface MetricsRuntimeDeps {
  sql: Sql;
  pay: Pick<PayService, 'getMerchant' | 'getMerchantByUserId'> & BalanceReader;
  trees: MerchantAreaFence | null;
  rails: { health(): Array<{ id: string; usable: boolean; healthy: boolean; reason?: string | undefined }> };
  /** Defaults to a count of open and claimed rows in pay.fraud_review_cases. */
  openFraudReviews?: (merchantId?: string) => number | Promise<number>;
  now?: () => Date;
}

export const railHealthRows = (rails: MetricsRuntimeDeps['rails']): RailHealthRow[] =>
  rails.health().map((h) => ({ railId: h.id, ok: h.usable && h.healthy, detail: h.reason ?? null }));

export function createMetricsRuntime(deps: MetricsRuntimeDeps): MetricsRuntime {
  return {
    projector: new MetricsProjector(deps.sql),
    authority: createMerchantMetricsAuthority(deps.pay, deps.trees),
    reader: new MetricsReader({
      sql: deps.sql,
      balances: deps.pay,
      openFraudReviews:
        deps.openFraudReviews ??
        (async (merchantId) => {
          const rows = await deps.sql<Array<{ n: number }>>`
            SELECT count(*)::int AS n
              FROM pay.fraud_review_cases
             WHERE status IN ('open', 'claimed')
               ${merchantId ? deps.sql`AND merchant_id = ${merchantId}` : deps.sql``}`;
          return Number(rows[0]?.n ?? 0);
        }),
      railHealth: () => railHealthRows(deps.rails),
      ...(deps.now ? { now: deps.now } : {}),
    }),
  };
}
