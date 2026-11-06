import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { PayError, appendEvent, assertTransition, lockPayment, railPayload, readPayment, refuseUnusableRail } from './internal.js';
import { withRailSpan } from '../tracing.js';
import type { PayServiceInternal, PaymentView } from '../payment-service.js';

/**
 * J-merchant-06 #6: release an authorisation that was never captured.
 *
 * No value moved when the payment was authorised (the ledger is posted at capture), so a void posts nothing. It follows
 * the saga law all the same, because the rail holds the payer's funds:
 *
 * 1. The intent is recorded first (`void.requested`), in its own transaction, before the rail is asked. From then on
 *    the payment cannot be captured (`capture` refuses `pay.void_in_flight`), so a capture cannot race the release.
 * 2. The rail is asked to release the charge by its reference (idempotent on the reference).
 * 3. A definite answer is recorded: `voided` moves the payment to `voided` (no exit); a definite refusal records it
 *    and clears the intent (`void.refused`), so the payment is an authorisation again.
 * 4. An unknown answer (a throw, a timeout) keeps the intent and the authorisation: the payment shows "checking", and a
 *    retry asks the rail again with the same reference. Nothing is guessed.
 *
 * A voided payment voided again answers the same view and asks the rail nothing.
 */
export async function voidPayment(svc: PayServiceInternal, paymentId: string): Promise<PaymentView> {
  const original = await readPayment(svc.sql, paymentId);
  if (original.status === 'voided') return svc.getPayment(paymentId);
  if (original.status !== 'authorized') {
    throw new PayError(
      `Payment ${paymentId} is ${original.status}; only an authorised, uncaptured payment is voided`,
      'pay.void_not_authorized',
      {
        status: original.status,
      },
    );
  }
  const adapter = svc.rails.has(original.rail_adapter) ? svc.rails.get(original.rail_adapter) : null;
  if (!adapter || typeof adapter.void !== 'function') {
    throw new PayError(`Rail ${original.rail_adapter} cannot release an authorisation`, 'pay.void_unsupported', {
      rail: original.rail_adapter,
    });
  }
  refuseUnusableRail(adapter, svc.now());

  // (1) The intent, first and on its own.
  const railRef = await transaction(svc.sql, async (tx) => {
    const row = await lockPayment(tx, paymentId);
    if (row.status === 'voided') return null;
    assertTransition(row, 'voided');
    if (!row.rail_ref) throw new PayError(`Payment ${row.id} has no rail reference to void`, 'pay.invalid_transition');
    if (!(await voidInFlight(tx, row.id))) await appendEvent(tx, row.id, 'void.requested', { railRef: row.rail_ref });
    return row.rail_ref;
  });
  if (railRef === null) return svc.getPayment(paymentId);

  // (2) The rail. A throw here is an unknown outcome: the intent and the authorisation stay.
  let result;
  try {
    result = await withRailSpan(adapter.id, 'void', async () => adapter.void!(railRef));
  } catch (error) {
    throw new PayError(
      `Void of payment ${paymentId} has no answer from the rail yet; it is kept and checked again`,
      'pay.void_outcome_unknown',
      {
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }

  // (3) The rail's definite answer.
  return transaction(svc.sql, async (tx) => {
    const row = await lockPayment(tx, paymentId);
    if (row.status === 'voided') return svc.view(tx, row);
    await appendEvent(tx, row.id, 'rail.void', railPayload(result));
    if (!result.ok || result.status !== 'voided') {
      await appendEvent(tx, row.id, 'void.refused', { failureCode: result.failureCode ?? null });
      throw new PayError(result.failureReason ?? 'Rail refused to void', 'pay.rail_failed', { failureCode: result.failureCode });
    }
    assertTransition(row, 'voided');
    await appendEvent(tx, row.id, 'voided', { railRef });
    await tx`UPDATE pay.payments SET status = 'voided', updated_at = now() WHERE id = ${row.id}`;
    return svc.view(tx, { ...row, status: 'voided' });
  });
}

/** Whether a void was asked of the rail and its answer is not on record yet. */
export async function voidInFlight(tx: Sql, paymentId: string): Promise<boolean> {
  const rows = await tx<Array<{ event: string }>>`
    SELECT event FROM pay.payment_events
     WHERE payment_id = ${paymentId} AND event IN ('void.requested', 'void.refused', 'voided')
     ORDER BY seq DESC LIMIT 1
  `;
  return rows[0]?.event === 'void.requested';
}
