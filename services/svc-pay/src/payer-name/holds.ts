import type { Sql } from 'postgres';
import { formatAmount, type Amount } from '@intafaced/ledger-client';
import { PayError, appendEvent } from '../payment-service/internal.js';
import { checkPayerNames, type PayerNameHoldReason, type PayerNameMatchRule } from './match.js';

/**
 * WHERE THE PAYER-NAME CHECK MEETS THE PAYMENT (RC-merchant-09, J-merchant-04 step 6).
 *
 * What is checked: a payment on a rail that `checksPayerName` (a pushed bank transfer, where the payer chooses which
 * account the money comes from). The name the payer gave is stored when the payment opens (`pay.payer_names`). Inside
 * `authorize`, with the payment locked, the name of every transfer the rail counted is checked before anything is
 * authorized. One that fails holds the payment (`pay.payer_name_holds`, one per payment): it stays `created`, nothing is
 * authorized, captured or settled, and nothing is posted to the ledger. While a hold is open, `authorize` and `capture`
 * refuse `pay.payer_name_held` on every path, so no other door takes the money in.
 *
 * IF THIS CRASHES between the check and the hold's write, whose funds are stranded? Nobody's: both are in the one
 * transaction that would have authorized, so it rolls back whole; no ledger post has happened, the delivery's dedupe
 * marker is written only after it, and the bank's redelivery runs the same check on the same transfers. The payer's
 * money sits at the bank, visible to the review as soon as the hold is written.
 */

/** The checkout method a payer gives a name for: the one the name-checking rails take. */
export const NAME_CHECKED_METHOD = 'bank_transfer';

/** Store the name the payer gave, in the payment's own opening transaction. */
export async function recordGivenPayerName(tx: Sql, paymentId: string, name: string): Promise<void> {
  await tx`INSERT INTO pay.payer_names (payment_id, given_name) VALUES (${paymentId}, ${name})`;
}

/** The payment's open hold, if it has one: its reason only. Names never leave these tables. */
export async function payerNameHoldOf(sql: Sql, paymentId: string): Promise<{ reason: PayerNameHoldReason; heldAt: Date } | null> {
  const [row] = await sql<Array<{ reason: PayerNameHoldReason; held_at: Date }>>`
    SELECT reason, held_at FROM pay.payer_name_holds WHERE payment_id = ${paymentId} AND status = 'held'`;
  return row ? { reason: row.reason, heldAt: row.held_at } : null;
}

/** Whether the payment is held and still open: a payment the bank later failed is no longer waiting on a review. */
export async function isHeldOpenPayment(sql: Sql, paymentId: string): Promise<boolean> {
  const rows = await sql<Array<{ held: number }>>`
    SELECT 1 AS held FROM pay.payer_name_holds h JOIN pay.payments p ON p.id = h.payment_id
     WHERE h.payment_id = ${paymentId} AND h.status = 'held' AND p.status = 'created'`;
  return rows.length > 0;
}

/** Refuse to authorize or capture a payment while a payer-name hold is open. Call with the payment row locked. */
export async function assertNoPayerNameHold(tx: Sql, paymentId: string): Promise<void> {
  const hold = await payerNameHoldOf(tx, paymentId);
  if (hold) {
    throw new PayError('This payment is held for a payer-name review. Nothing was authorized or captured.', 'pay.payer_name_held', {
      reason: hold.reason,
    });
  }
}

/**
 * Check the names of every transfer a name-checking rail counted towards this payment, inside the transaction that
 * would authorize it, with the payment row locked. `pass` lets the authorization go on. `held` means it must not: the
 * payment is held now (or already was), stays `created`, and nothing is authorized, captured or posted.
 *
 * Checking exactly the money the rail is about to hand over, under the payment lock, is what stops a transfer from
 * another name being counted in with a later one from the right name.
 */
export async function holdOnPayerNames(
  tx: Sql,
  rule: PayerNameMatchRule | null,
  payment: { id: string; merchant_id: string; currency: string },
  counted: { payerNames: readonly (string | null)[] | undefined; received: Amount },
): Promise<'pass' | 'held'> {
  if (await payerNameHoldOf(tx, payment.id)) return 'held';
  // (Names go in through JSON so a transfer with no name is stored as SQL NULL, never as the text "NULL".)
  // A rail that checks names but did not say whose money it counted is treated as a bank that reported no name.
  const names = counted.payerNames ?? (counted.received > 0n ? [null] : []);
  const [given] = await tx<Array<{ given_name: string }>>`SELECT given_name FROM pay.payer_names WHERE payment_id = ${payment.id}`;
  const verdict = checkPayerNames(rule, given?.given_name ?? null, names);
  if (verdict.outcome === 'match') return 'pass';
  const held = await tx<Array<{ payment_id: string }>>`
    INSERT INTO pay.payer_name_holds (payment_id, merchant_id, reason, rule, received_names, amount, currency)
    VALUES (${payment.id}, ${payment.merchant_id}, ${verdict.reason}, ${rule}, ARRAY(SELECT jsonb_array_elements_text(${tx.json(names as never)}::jsonb)),
            ${formatAmount(counted.received)}::numeric, ${payment.currency})
    ON CONFLICT (payment_id) DO NOTHING
    RETURNING payment_id`;
  // The reason and what arrived, never a name: payment events are read by every team role.
  if (held.length > 0)
    await appendEvent(tx, payment.id, 'payer_name.held', {
      reason: verdict.reason,
      rule,
      amount: formatAmount(counted.received),
      currency: payment.currency,
      transfers: names.length,
    });
  return 'held';
}
