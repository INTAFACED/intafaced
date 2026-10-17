import type { Sql } from 'postgres';
import { PayGuardRefusal, type GuardReplay, type PartialPayGuards } from '../seams/guards.js';
import { merchantIdsWithLegacySettlement, type SettlementBookReader } from '../settlement-book.js';
import { findBlockingHalt, findBlockingHaltForTargets, railHaltKey, userHaltKey } from './store.js';
import type { PayHaltScope } from './types.js';

/**
 * HALT GUARDS (W5), the in-service layer behind the edge kill switch.
 *
 * WHICH SEAM CHECKS WHICH SCOPE
 *   beforePaymentAdmit         intake       (create, authorize and capture alike)
 *   beforePayoutAdmit          payout
 *   beforePayoutExecute        payout
 *   beforeSettlementRun        settlement   (prepare and post)
 *   beforeConversion           conversion
 *   beforeUserMoneyWithdrawal  payout       (the global switch, always; the switch of
 *                              every merchant the user owns that still has a legacy
 *                              settlement; that user's own withdrawal switch; and the
 *                              switch of the rail being asked. A legacy window's post
 *                              debited userAvailable, and withdrawal.create debits the
 *                              same account. A merchant whose settled net is only on
 *                              proceeds is not this exit.)
 *   beforeRefund               NONE, by decision: a refund returns a payer's own
 *                              money. A halt that traps funds is not a safety
 *                              control (the edge switch lets `cancel` through for
 *                              the same reason). Refunds are still bounded by
 *                              the merchant's balance and the ledger.
 *
 * RULES (seams/guards.ts)
 *   - A `replay` does nothing new and is never stopped. Beyond that the rule
 *     depends on whether the work SENDS money to a rail:
 *       bookkeeping (payment admit, settlement run, conversion): only FRESH work
 *       is refused. A `recovery` finishes value already in flight (a frozen window,
 *       a captured payment) and does not even read the store.
 *       rail sends (`beforePayoutExecute`, `beforeUserMoneyWithdrawal`): a payout
 *       halt also refuses a `recovery`, because finishing it calls the rail and
 *       money would leave. The booked hold is left exactly as it is, so the
 *       operation is PAUSED, not stranded: nothing is released or marked failed,
 *       and the same call completes once the halt clears. The global payout
 *       switch is that halt for every personal withdrawal. A merchant switch is
 *       that halt only while the merchant still has a legacy settlement.
 *       A held withdrawal whose rail attempt already has a recorded outcome (accepted
 *       with a receipt, or refused) sends nothing: `UserMoneyService` classifies it a
 *       `replay` (settle or reverse only), so a halt never freezes that bookkeeping.
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

/** Bookkeeping work: only fresh work is stopped. */
const passes = (replay: GuardReplay): boolean => replay.kind !== 'fresh';
/** Work that calls a rail: only a replay (which does nothing) is let through a halt. */
const passesRailSend = (replay: GuardReplay): boolean => replay.kind === 'replay';

/**
 * Throw unless `scope` is running for this merchant. Reads through `conn`.
 * `railSend` marks work that would call a rail: a recovery is then refused too.
 */
export async function assertNotHalted(
  conn: Sql,
  scope: PayHaltScope,
  merchantId: string | undefined,
  replay: GuardReplay,
  opts: { railSend?: boolean; railId?: string } = {},
): Promise<void> {
  if (opts.railSend ? passesRailSend(replay) : passes(replay)) return;
  let blocking;
  try {
    blocking = await findBlockingHalt(conn, scope, merchantId, opts.railId);
  } catch (error) {
    if (RETRYABLE_PG.has((error as { code?: string } | null)?.code ?? '')) throw error;
    throw new PayGuardRefusal(GUARD_HALT_STORE_UNAVAILABLE, 'unavailable');
  }
  if (blocking) throw new PayGuardRefusal(GUARD_HALTED, 'unavailable');
}

/**
 * Personal withdrawals. The global payout switch always counts. A merchant
 * switch counts only while that merchant still has legacy settled net on
 * `userAvailable`. The user's own switch and the rail being asked always
 * count. Replay settles or reverses a receipt already on file and sends
 * nothing. A fresh withdrawal and a recovery both call the rail, so a
 * matching halt pauses them. Fails closed.
 */
async function assertUserMoneyNotHalted(
  conn: Sql,
  userId: string,
  railId: string,
  replay: GuardReplay,
  ledger: SettlementBookReader | undefined,
): Promise<void> {
  if (passesRailSend(replay)) return;
  let targets: string[];
  try {
    const legacy = await merchantIdsWithLegacySettlement(conn, ledger, userId);
    targets = [...legacy, userHaltKey(userId), railHaltKey(railId)];
  } catch (error) {
    if (RETRYABLE_PG.has((error as { code?: string } | null)?.code ?? '')) throw error;
    throw new PayGuardRefusal(GUARD_HALT_STORE_UNAVAILABLE, 'unavailable');
  }
  let blocking;
  try {
    // findBlockingHaltForTargets always includes 'global'.
    blocking = await findBlockingHaltForTargets(conn, 'payout', targets);
  } catch (error) {
    if (RETRYABLE_PG.has((error as { code?: string } | null)?.code ?? '')) throw error;
    throw new PayGuardRefusal(GUARD_HALT_STORE_UNAVAILABLE, 'unavailable');
  }
  if (blocking) throw new PayGuardRefusal(GUARD_HALTED, 'unavailable');
}

export function createHaltGuards(deps: {
  sql: Sql;
  /** Settlement-key reader. Absent: a posted window counts as legacy (fail closed). */
  ledger?: SettlementBookReader;
}): PartialPayGuards {
  // The connection arrives on each call. Auto-trip counts are not computed here:
  // a rail-health refusal records itself and, at the configured count, writes
  // the halt these guards then enforce.
  return {
    beforePaymentAdmit: (ctx) => assertNotHalted(ctx.tx, 'intake', ctx.merchantId, ctx.replay),
    beforePayoutAdmit: (ctx) => assertNotHalted(ctx.tx, 'payout', ctx.merchantId, ctx.replay, { railSend: true, railId: ctx.railId }),
    beforePayoutExecute: (ctx) => assertNotHalted(ctx.sql, 'payout', ctx.merchantId, ctx.replay, { railSend: true, railId: ctx.railId }),
    beforeSettlementRun: (ctx) => assertNotHalted(ctx.sql, 'settlement', ctx.merchantId, ctx.replay),
    // Conversion runs inside the order-intent transaction. `tx` is that transaction; the pool is not a lock.
    beforeConversion: (ctx) => assertNotHalted(ctx.tx, 'conversion', ctx.merchantId, ctx.replay),
    beforeUserMoneyWithdrawal: (ctx) => assertUserMoneyNotHalted(ctx.tx, ctx.userId, ctx.rail, ctx.replay, deps.ledger),
    // beforeRefund: deliberately absent. See the table above.
  };
}
