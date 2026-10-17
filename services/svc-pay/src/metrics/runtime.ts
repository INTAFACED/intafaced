import type { Sql } from 'postgres';
import type { MerchantAreaFence } from '../merchant-ownership.js';
import type { PayService } from '../payment-service.js';
import { defaultFraudReviewQueue } from '../fraud/review-queue.js';
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
  /** Defaults to the process-local fraud review queue (the only one that exists today). */
  openFraudReviews?: (merchantId?: string) => number;
  now?: () => Date;
}

/** Largest page the review queue will return. A count at this value is a floor, not a total. */
const FRAUD_QUEUE_PAGE = 200;

export const railHealthRows = (rails: MetricsRuntimeDeps['rails']): RailHealthRow[] =>
  rails.health().map((h) => ({ railId: h.id, ok: h.usable && h.healthy, detail: h.reason ?? null }));

export function createMetricsRuntime(deps: MetricsRuntimeDeps): MetricsRuntime {
  return {
    projector: new MetricsProjector(deps.sql),
    authority: createMerchantMetricsAuthority(deps.pay, deps.trees),
    reader: new MetricsReader({
      sql: deps.sql,
      balances: deps.pay,
      // The review queue is in-memory per process (fraud/review-queue.ts); a durable store is an open residual.
      openFraudReviews: deps.openFraudReviews ?? ((merchantId) => defaultFraudReviewQueue.listOpen(merchantId, FRAUD_QUEUE_PAGE).length),
      railHealth: () => railHealthRows(deps.rails),
      ...(deps.now ? { now: deps.now } : {}),
    }),
  };
}
