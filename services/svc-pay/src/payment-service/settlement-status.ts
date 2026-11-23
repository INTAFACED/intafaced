/**
 * The one way a settlement's status changes. `SETTLEMENT_MOVES` is the table of legal moves; `moveSettlement` writes a
 * move as one `UPDATE … AND status = ANY(<legal predecessors>)` and refuses with `SettlementMoveError` when no row moved,
 * so a write from a status the table does not list (a stale read, a lost lock, a second writer) changes nothing.
 *
 * `settlement-status.test.ts` fails any other `UPDATE pay.settlements` in svc-pay that sets `status`.
 */
import type { Queryable } from '@intafaced/db';
import { z } from 'zod';
import type { SettlementStatus } from '../payment-service.js';
import { PayError } from './internal.js';

/** From each status, the statuses it may move to. */
export const SETTLEMENT_MOVES: Readonly<Record<SettlementStatus, readonly SettlementStatus[]>> = {
  // A frozen window posts into the ledger, or is released before it posts (`failed`, `pay.settlement_released`).
  pending: ['posted', 'failed'],
  // A posted window is paid out, or its payout is refused or answered not sent.
  posted: ['paid_out', 'failed'],
  // A failed payout may be sent again: paid out, or failed once more on the next attempt.
  failed: ['paid_out', 'failed'],
  paid_out: [],
};

const STATUSES = ['pending', 'posted', 'paid_out', 'failed'] as const satisfies readonly SettlementStatus[];
const CurrentStatus = z.object({ status: z.enum(STATUSES) });

/** The statuses a settlement may move to `to` from. */
export function settlementPredecessors(to: SettlementStatus): SettlementStatus[] {
  return STATUSES.filter((from) => SETTLEMENT_MOVES[from].includes(to));
}

export type SettlementMove =
  /** The window's ledger post landed. */
  | { readonly to: 'posted' }
  /** The rail sent it. */
  | { readonly to: 'paid_out'; readonly payoutMethod: string; readonly payoutRef: string }
  /** Refused, answered not sent, or released. A payout failure names the attempts it used; a release leaves them. */
  | { readonly to: 'failed'; readonly failureCode: string; readonly payoutAttempts?: number };

export class SettlementMoveError extends PayError {
  constructor(
    readonly settlementId: string,
    readonly to: SettlementStatus,
    readonly from: SettlementStatus | null,
  ) {
    super(
      from === null
        ? `Settlement ${settlementId} not found; cannot move it to ${to}`
        : `Settlement ${settlementId} cannot go from ${from} to ${to}`,
      'pay.invalid_transition',
      { settlementId, from, to },
    );
    this.name = 'SettlementMoveError';
  }
}

/** Move one settlement. Zero rows moved (an illegal predecessor, or no such row) throws `SettlementMoveError`. */
export async function moveSettlement(tx: Queryable, settlementId: string, move: SettlementMove): Promise<void> {
  const from = settlementPredecessors(move.to);
  let moved: readonly unknown[];
  switch (move.to) {
    case 'posted':
      moved = await tx`
        UPDATE pay.settlements
           SET status = 'posted', payout_method = 'ledger', settled_at = COALESCE(settled_at, now()), updated_at = now()
         WHERE id = ${settlementId} AND status::text = ANY(${from})
        RETURNING id`;
      break;
    case 'paid_out':
      moved = await tx`
        UPDATE pay.settlements
           SET status = 'paid_out', payout_method = ${move.payoutMethod}, payout_ref = ${move.payoutRef},
               sent_at = COALESCE(sent_at, now()), failed_at = NULL, failure_code = NULL, updated_at = now()
         WHERE id = ${settlementId} AND status::text = ANY(${from})
        RETURNING id`;
      break;
    case 'failed':
      moved = await tx`
        UPDATE pay.settlements
           SET status = 'failed', payout_attempts = COALESCE(${move.payoutAttempts ?? null}::int, payout_attempts),
               failed_at = now(), failure_code = ${move.failureCode}, updated_at = now()
         WHERE id = ${settlementId} AND status::text = ANY(${from})
        RETURNING id`;
      break;
    default: {
      const unhandled: never = move;
      throw new Error(`unhandled settlement move ${JSON.stringify(unhandled)}`);
    }
  }
  if (moved.length > 0) return;
  const rows = CurrentStatus.array().parse(await tx`SELECT status FROM pay.settlements WHERE id = ${settlementId}`);
  throw new SettlementMoveError(settlementId, move.to, rows[0]?.status ?? null);
}
