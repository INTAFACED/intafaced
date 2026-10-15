import type { Sql } from 'postgres';
import { PayGuardRefusal, type GuardReplay, type PartialPayGuards } from '../seams/guards.js';
import { findBlockingHalt, type PayHaltStore } from './store.js';
import type { PayHaltScope } from './types.js';

/**
 * HALT GUARDS (W5), the in-service layer behind the edge kill switch.
 *
 * WHICH SEAM CHECKS WHICH SCOPE
 *   beforePaymentAdmit         intake       (create, authorize and capture alike)
 *   beforePayoutAdmit          payout       (+ auto-trip from the payout book)
 *   beforePayoutExecute        payout       (+ auto-trip from the payout book)
 *   beforeSettlementRun        settlement   (prepare and post)
 *   beforeConversion           conversion
 *   beforeUserMoneyWithdrawal  payout       (global switch; a user has no merchant)
 *   beforeRefund               NONE, by decision: a refund returns a payer's own
 *                              money. A halt that traps funds is not a safety
 *                              control (the edge switch lets `cancel` through for
 *                              the same reason). Refunds are still bounded by
 *                              the merchant's balance and the ledger.
 *
 * RULES (seams/guards.ts)
 *   - Only FRESH work is refused. A `replay` does nothing new and a `recovery`
 *     finishes value already in flight (a booked hold, a frozen window); neither
 *     is stopped, and a recovery does not even read the store.
 *   - Unreadable store = refused with `pay.guard_halt_store_unavailable`
 *     (SERVICE_UNAVAILABLE). Never "not halted".
 *   - A halted scope = `pay.guard_halted` (SERVICE_UNAVAILABLE). The code does not
 *     say who set it or why.
 *   - Postgres serialization and deadlock errors pass through so the surrounding
 *     transaction retries.
 */

const RETRYABLE_PG = new Set(['40001', '40P01']);

export const GUARD_HALTED = 'pay.guard_halted' as const;
export const GUARD_HALT_STORE_UNAVAILABLE = 'pay.guard_halt_store_unavailable' as const;

const passes = (replay: GuardReplay): boolean => replay.kind !== 'fresh';

/** Throw unless `scope` is running for this merchant. Reads through `conn`. */
export async function assertNotHalted(conn: Sql, scope: PayHaltScope, merchantId: string | undefined, replay: GuardReplay): Promise<void> {
  if (passes(replay)) return;
  let blocking;
  try {
    blocking = await findBlockingHalt(conn, scope, merchantId);
  } catch (error) {
    if (RETRYABLE_PG.has((error as { code?: string } | null)?.code ?? '')) throw error;
    throw new PayGuardRefusal(GUARD_HALT_STORE_UNAVAILABLE, 'unavailable');
  }
  if (blocking) throw new PayGuardRefusal(GUARD_HALTED, 'unavailable');
}

/**
 * Latest `failures` terminal rail results for `railId` since the payout switch last changed:
 * all refusals means the rail has failed that many times in a row.
 */
async function railFailureStreakReached(conn: Sql, store: PayHaltStore, railId: string, failures: number): Promise<boolean> {
  const since = await store.lastChangeAt(conn, 'payout', { level: 'global' });
  const rows = await conn<Array<{ kind: string }>>`
    SELECT o.kind
      FROM pay.payout_outcomes o
      JOIN pay.payout_admissions a ON a.id = o.admission_id
     WHERE a.rail_id = ${railId}
       AND o.kind IN ('rail_accepted', 'rail_refused')
       AND (${since}::timestamptz IS NULL OR o.occurred_at > ${since}::timestamptz)
     ORDER BY o.id DESC
     LIMIT ${failures}
  `;
  return rows.length === failures && rows.every((r) => r.kind === 'rail_refused');
}

export function createHaltGuards(deps: { sql: Sql; store: PayHaltStore }): PartialPayGuards {
  const failures = deps.store.autoTripPosture().consecutiveFailures;

  /** Auto-trip from the payout book. The halt is written on the POOL, so it outlives the caller's rolled-back transaction. */
  async function payoutRailGuard(conn: Sql, merchantId: string, railId: string, replay: GuardReplay): Promise<void> {
    await assertNotHalted(conn, 'payout', merchantId, replay);
    if (passes(replay) || failures === null) return;
    let reached: boolean;
    try {
      reached = await railFailureStreakReached(conn, deps.store, railId, failures);
    } catch (error) {
      if (RETRYABLE_PG.has((error as { code?: string } | null)?.code ?? '')) throw error;
      throw new PayGuardRefusal(GUARD_HALT_STORE_UNAVAILABLE, 'unavailable');
    }
    if (!reached) return;
    try {
      await deps.store.trip('payout', { level: 'global' }, `auto_trip: ${failures} consecutive refusals by rail ${railId}`);
    } catch {
      // The refusal below is what matters; a failed trip write must not let the payout through.
    }
    throw new PayGuardRefusal(GUARD_HALTED, 'unavailable');
  }

  return {
    beforePaymentAdmit: (ctx) => assertNotHalted(ctx.tx, 'intake', ctx.merchantId, ctx.replay),
    beforePayoutAdmit: (ctx) => payoutRailGuard(ctx.tx, ctx.merchantId, ctx.railId, ctx.replay),
    beforePayoutExecute: (ctx) => payoutRailGuard(ctx.sql, ctx.merchantId, ctx.railId, ctx.replay),
    beforeSettlementRun: (ctx) => assertNotHalted(ctx.sql, 'settlement', ctx.merchantId, ctx.replay),
    beforeConversion: (ctx) => assertNotHalted(ctx.sql, 'conversion', ctx.merchantId, ctx.replay),
    beforeUserMoneyWithdrawal: (ctx) => assertNotHalted(ctx.tx, 'payout', undefined, ctx.replay),
    // beforeRefund: deliberately absent. See the table above.
  };
}
