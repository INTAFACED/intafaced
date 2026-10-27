/**
 * A payment's life before refunds: create, admit, authorize and capture, and the capture reconcile.
 *
 * Moved out of `payment-service.ts` as it was (owner decision 2026-10-23): `PayService` keeps one method per
 * function here, which passes itself as `svc`.
 */
import { assertCategoryAllows, merchantCategoryRule } from '../onboarding-policy/category.js';
import { postPayLedger } from '../ledger-receipt.js';
import {
  CaptureReconcileError,
  runCaptureReconcile,
  type BookedCaptureCompletion,
  type CaptureReconcileInput,
  type CaptureReconcileMode,
  type CaptureReconcileReport,
} from '../capture-reconcile.js';
import { randomUUID } from 'node:crypto';
import { withPaymentAdmission, type PreparedPaymentOperation } from '../payment-admission.js';
import { FRESH, type GuardReplay } from '../seams/guards.js';
import type { Sql } from 'postgres';
import { formatAmount, parseAmount, recipes, type Amount } from '@intafaced/ledger-client';
import { isSandboxRailId } from '../sandbox-key-routing.js';
import { isRailHealthBlockingCode, railReasonCode, type PaymentIntent, type RailResult } from '../rails/rail-adapter.js';
import { PayoutAdmissionError, stable } from '../payout-admission.js';
import { assertNoPayerNameHold, holdOnPayerNames } from '../payer-name/holds.js';
import { withMoneySpan, withRailSpan } from '../tracing.js';
import type { PayService, PayServiceInternal, PaymentRow, PaymentStatus, PaymentView } from '../payment-service.js';
import {
  PayError,
  appendEvent,
  assertTransition,
  completeCheckoutSession,
  insertPayment,
  instrumentFor,
  lockPayment,
  paymentCreationPayload,
  railPayload,
  readPayment,
  refuseUnusableRail,
  toPayment,
} from './internal.js';

// ── Payment lifecycle ──────────────────────────────────────────────────────

/**
 * `created`. Nothing has been asked of a rail yet and no value has moved.
 *
 * The rail is chosen by the caller in this PR. Smart routing — geo, method,
 * amount band, risk score, live approval rates — is its own tracker feature
 * and slots in exactly here, choosing `railAdapter`, with nothing else in
 * this file changing.
 */
export async function createPayment(
  svc: PayServiceInternal,
  input: {
    requestId?: string;
    identityAuthority?: import('@intafaced/contracts').IdentityOperationIntent['authority'];
    merchantId: string;
    profileId?: string | null;
    amount: Amount;
    assetId: string;
    method: string;
    railAdapter: string;
    instrument?: PaymentIntent['instrument'];
    customerRef?: string;
    metadata?: Record<string, string>;
    /**
     * From the API key. `sandbox` is copied onto the created event and never
     * updated. Absent is not sandbox: a session or an in-process fixture is
     * not a sandbox credential.
     */
    keyEnv?: 'live' | 'sandbox';
  },
): Promise<PaymentView> {
  if (input.amount <= 0n) throw new PayError('Payment amount must be positive', 'pay.invalid_amount');

  // A sandbox key on a live rail is refused here, before the rail lookup, the
  // guard, admission, and the insert. REST already resolves that key onto
  // card-sandbox. This method does not reroute: a blank or unknown rail is
  // not a sandbox rail, and naming a live rail must not create a row.
  if (input.keyEnv === 'sandbox' && !isSandboxRailId(input.railAdapter)) {
    throw new PayError(
      'A sandbox API key cannot create a payment on a live rail. NOTHING WAS ATTEMPTED.',
      'pay.sandbox_live_account_refused',
      { railAdapter: input.railAdapter },
    );
  }

  // Resolved now so an unknown or incapable rail fails before a payment row
  // exists, rather than at authorize time with a buyer watching.
  svc.rails.require(input.railAdapter, 'authorize');

  if (input.profileId) {
    const profiles = await svc.sql<Array<{ id: string }>>`
      SELECT id FROM pay.payment_profiles
       WHERE id = ${input.profileId} AND merchant_id = ${input.merchantId}
    `;
    if (!profiles[0]) throw new PayError('payment profile not found for merchant', 'pay.profile_not_found');
  }

  const paymentId = input.requestId?.toLowerCase() ?? randomUUID();
  const prior = input.requestId ? await svc.existingPaymentCreation(svc.sql, input, paymentId) : null;
  // RC-merchant-08: new intake only. A prohibited category, a restricted one with blank reserve terms, and a rail the
  // category does not allow are refused by name before any row. A retry of a payment that exists is not new intake.
  // The guard slot re-checks inside the admission transaction.
  if (!prior) {
    assertCategoryAllows(await merchantCategoryRule(svc.sql, input.merchantId), input.railAdapter, {
      sandboxKey: input.keyEnv === 'sandbox',
    });
  }
  return svc.admitPaymentOperation(
    {
      paymentId,
      merchantId: input.merchantId,
      kind: 'payment.create',
      authority: input.identityAuthority,
      payload: paymentCreationPayload(input, paymentId),
    },
    async (tx, admitted) => {
      // Merchant lock and the guard already ran in admitPaymentOperation.
      const existing = await svc.existingPaymentCreation(tx, input, paymentId);
      if (existing) return existing;
      const row = await insertPayment(tx, { ...input, id: paymentId, sandbox: input.keyEnv === 'sandbox' });
      return { ...toPayment(row), capturedAmount: 0n, refundedAmount: 0n };
    },
  );
}

export async function admitPaymentOperation<T>(
  svc: PayServiceInternal,
  input: PreparedPaymentOperation,
  effect: (tx: Sql, admitted: boolean) => Promise<T>,
): Promise<T> {
  try {
    return await withPaymentAdmission(
      svc.sql,
      svc.identityOperationAdmission,
      input,
      async (tx) => svc.assertMerchantActive(await svc.lockMerchantEligibility(tx, input.merchantId)),
      // Seam: runs inside the effect transaction on both the identity and the
      // no-identity path, so no admission skips it, and at ONE point in the lock
      // order on both (seams/guards.ts): merchant row, guard, payment row. With
      // identity on, the wrapper has already taken the merchant lock; without
      // it, take the same lock here, before the guard.
      async (tx, admitted) => {
        if (!admitted) svc.assertMerchantActive(await svc.lockMerchantEligibility(tx, input.merchantId));
        await svc.guards.beforePaymentAdmit({
          tx,
          kind: input.kind,
          paymentId: input.paymentId,
          merchantId: input.merchantId,
          payload: input.payload,
          replay: await svc.classifyPaymentAdmission(tx, input),
        });
        return effect(tx, admitted);
      },
      svc.identityAuthorityGuard,
    );
  } catch (error) {
    if (error instanceof PayoutAdmissionError) throw new PayError(error.message, error.code);
    throw error;
  }
}

/**
 * Fresh, replay or recovery for a payment admission, from durable state, read
 * without locking the payment row (the guard runs before it is locked).
 *   create     the payment row exists: an idempotent repeat.
 *   authorize  already authorized or beyond: an idempotent repeat.
 *   capture    already captured or beyond: an idempotent repeat; still
 *              `authorized` but the ledger already holds the capture key: a
 *              recovery (the post landed, the projection did not).
 * A rail capture whose ledger post rolled back leaves no trace and is `fresh`.
 */
export async function classifyPaymentAdmission(svc: PayServiceInternal, tx: Sql, input: PreparedPaymentOperation): Promise<GuardReplay> {
  const rows = await tx<Array<{ status: PaymentStatus }>>`SELECT status FROM pay.payments WHERE id=${input.paymentId}`;
  const status = rows[0]?.status;
  if (!status) return FRESH;
  if (input.kind === 'payment.create') return { kind: 'replay', reason: 'payment_exists' };
  const beyondCapture = status === 'captured' || status === 'settled' || status === 'refunded';
  if (input.kind === 'payment.authorize') {
    return beyondCapture || status === 'authorized' ? { kind: 'replay', reason: 'already_authorized' } : FRESH;
  }
  if (beyondCapture) return { kind: 'replay', reason: 'already_captured' };
  if (status === 'authorized' && (await svc.ledger.getTxByKey(`payment.capture:${input.paymentId.toLowerCase()}`)))
    return { kind: 'recovery', reason: 'ledger_already_booked' };
  return FRESH;
}

export async function existingPaymentCreation(
  svc: PayServiceInternal,
  tx: Sql,
  input: Parameters<PayService['createPayment']>[0],
  paymentId: string,
): Promise<PaymentView | null> {
  const existing = await tx`SELECT id FROM pay.payments WHERE id=${paymentId}`;
  if (!existing[0]) return null;
  const current = await readPayment(tx, paymentId);
  const [created] = await tx`SELECT payload FROM pay.payment_events WHERE payment_id=${paymentId} AND event='created' LIMIT 1`;
  const expected = {
    amount: formatAmount(input.amount),
    assetId: input.assetId,
    method: input.method,
    railAdapter: input.railAdapter,
    customerRef: input.customerRef ?? null,
    instrument: input.instrument ?? null,
    metadata: input.metadata ?? {},
    ...(input.keyEnv === 'sandbox' ? { sandbox: true } : {}),
  };
  if (
    current.merchant_id !== input.merchantId.toLowerCase() ||
    current.profile_id !== (input.profileId?.toLowerCase() ?? null) ||
    !created ||
    stable(created.payload) !== stable(expected)
  )
    throw new PayError('Creation request differs from the original payment', 'pay.identity_admission_conflict');
  return svc.view(tx, current);
}

/**
 * `created → authorized`.
 *
 * No value moves here on any rail. A card authorization is a promise; a
 * crypto "authorization" is a confirmed transfer that is already ours but is
 * not booked until capture. Either way the ledger is untouched, which is why
 * this method can be retried freely.
 */
export async function authorize(
  svc: PayServiceInternal,
  paymentId: string,
  options: { identityAuthority?: import('@intafaced/contracts').IdentityOperationIntent['authority'] } = {},
): Promise<PaymentView> {
  return withMoneySpan('pay.authorize', { operation: 'authorize', paymentId }, async () => {
    const original = await readPayment(svc.sql, paymentId);
    if (['authorized', 'captured', 'settled'].includes(original.status)) return svc.getPayment(paymentId);
    // Checkout commits a prepared row with its create marker before asking
    // identity. A cancelled creation must never become a usable instruction.
    if (svc.identityOperationAdmission) {
      const prepared =
        await svc.sql`SELECT payload FROM pay.payment_admissions WHERE business_id=${`payment.create:${paymentId.toLowerCase()}`}`;
      if (prepared[0])
        await svc.admitPaymentOperation(
          {
            paymentId,
            merchantId: original.merchant_id,
            kind: 'payment.create',
            payload: prepared[0].payload as Record<string, unknown>,
          },
          async (tx) => svc.view(tx, await readPayment(tx, paymentId)),
        );
    }
    const outcome = await svc.admitPaymentOperation(
      {
        paymentId,
        merchantId: original.merchant_id,
        kind: 'payment.authorize',
        authority: options.identityAuthority,
        payload: {
          paymentId,
          merchantId: original.merchant_id,
          amount: formatAmount(parseAmount(original.amount)),
          assetId: original.currency,
          railId: original.rail_adapter,
          method: original.method,
          instrument: (await instrumentFor(svc.sql, paymentId)) ?? null,
        },
      },
      async (tx, admitted) => {
        const observed = await readPayment(tx, paymentId);

        // Idempotent: an authorization that already happened is not an error.
        if (observed.status === 'authorized' || observed.status === 'captured' || observed.status === 'settled') {
          return { declined: false as const, view: await svc.view(tx, observed) };
        }

        // Global money lock order: merchant eligibility (taken in
        // admitPaymentOperation, before the guard), then payment. Settlement
        // freezes use the same order. Re-check the payment after both locks: it
        // may have completed while this operation waited on a cutoff/settlement.
        const row = await lockPayment(tx, paymentId);
        if (row.status === 'authorized' || row.status === 'captured' || row.status === 'settled') {
          return { declined: false as const, view: await svc.view(tx, row) };
        }
        assertTransition(row, 'authorized');
        if (
          admitted &&
          (parseAmount(row.amount) !== parseAmount(original.amount) ||
            row.currency !== original.currency ||
            row.rail_adapter !== original.rail_adapter)
        )
          throw new PayError('Authorization payload changed after admission', 'pay.identity_admission_conflict');

        // A flagged payment on a live rail never reaches the rail. createPayment
        // refuses the same pair first. This catches a row inserted without that
        // check. Nothing is posted and authorize is not called.
        if ((await svc.paymentIsSandbox(tx, row.id)) && !isSandboxRailId(row.rail_adapter)) {
          throw new PayError(
            'A sandbox API key cannot create a payment on a live rail. NOTHING WAS ATTEMPTED.',
            'pay.sandbox_live_account_refused',
            { railAdapter: row.rail_adapter },
          );
        }

        const adapter = svc.rails.require(row.rail_adapter, 'authorize');
        refuseUnusableRail(adapter, svc.now());
        // RC-merchant-09: a payment held for a payer-name review is not taken in by any door until the review decides.
        if (adapter.checksPayerName) await assertNoPayerNameHold(tx, row.id);

        const intent: PaymentIntent = {
          paymentId: row.id,
          merchantId: row.merchant_id,
          amount: parseAmount(row.amount),
          assetId: row.currency,
          method: row.method,
          instrument: await instrumentFor(tx, row.id),
        };

        const result = await withRailSpan(adapter.id, 'authorize', async () => adapter.authorize(intent));
        // Health flipped between the gate above and this call, or the adapter
        // clock and this service's clock disagree. That is not a decline: the
        // rail never looked at the payment. Throw inside the transaction so
        // it rolls back, the row stays `created`, and no event is kept.
        if (!result.ok && isRailHealthBlockingCode(result.failureCode ?? '')) {
          const failureCode = railReasonCode(result.failureCode ?? '');
          throw new PayError(
            `Rail "${adapter.id}" is not usable (${result.failureReason ?? failureCode}). No value moved.`,
            'pay.rail_failed',
            { failureCode },
          );
        }
        await appendEvent(tx, row.id, 'rail.authorize', railPayload(result));

        // RC-merchant-09: on a rail the payer pushes money to, the name of every transfer the rail counted is checked here,
        // in this transaction and under this lock, before any of it is authorized. One that fails holds the payment.
        if (result.ok && adapter.checksPayerName) {
          const received = result.status === 'pending' ? pendingReceived(result) : result.amount;
          const names = await holdOnPayerNames(tx, svc.payerNameMatchRule, row, { payerNames: result.payerNames, received });
          if (names === 'held') {
            // The reference stays, so the payer's page still says where the money went. Nothing else moves.
            await tx`UPDATE pay.payments SET rail_ref = ${result.railRef || null}, updated_at = now() WHERE id = ${row.id}`;
            return { declined: false as const, view: await svc.view(tx, { ...row, rail_ref: result.railRef || null }) };
          }
        }

        if (!result.ok) {
          await appendEvent(tx, row.id, 'failed', {
            failureCode: result.failureCode ?? 'rail.failed',
            failureReason: result.failureReason ?? null,
          });
          await tx`UPDATE pay.payments SET status = 'failed', updated_at = now() WHERE id = ${row.id}`;
          // Recorded, then thrown OUTSIDE the transaction. Throwing from in
          // here would roll back the very rows that say the payment failed,
          // and the next call would ask a rail that has already declined.
          return { declined: true as const, result, view: await svc.view(tx, { ...row, status: 'failed' }) };
        }

        if (result.status === 'pending') {
          // The rail has taken the request but not completed it — on
          // crypto-native, the payer has not sent yet or is not deep enough.
          // The payment stays `created`: nothing has been authorized, and
          // saying otherwise is how a merchant ships against a transfer that
          // is still reorganisable.
          await tx`
            UPDATE pay.payments SET rail_ref = ${result.railRef || null}, updated_at = now() WHERE id = ${row.id}
          `;
          await appendEvent(tx, row.id, 'rail.pending', railPayload(result));
          return { declined: false as const, view: await svc.view(tx, { ...row, rail_ref: result.railRef || null }) };
        }

        // What the rail authorized is what was agreed — it may exceed what was
        // asked (a payer who overpays on-chain has still sent the funds, and
        // they are at an address we control). Booking the smaller number would
        // strand the difference.
        await tx`
          UPDATE pay.payments
             SET status = 'authorized', rail_ref = ${result.railRef},
                 amount = ${formatAmount(result.amount)}::numeric, updated_at = now()
           WHERE id = ${row.id}
        `;
        await appendEvent(tx, row.id, 'authorized', { amount: formatAmount(result.amount), railRef: result.railRef });

        return {
          declined: false as const,
          view: await svc.view(tx, {
            ...row,
            status: 'authorized',
            rail_ref: result.railRef,
            amount: formatAmount(result.amount),
          }),
        };
      },
    );

    if (outcome.declined) {
      throw new PayError(outcome.result.failureReason ?? 'Rail declined the authorization', 'pay.rail_declined', {
        failureCode: outcome.result.failureCode,
      });
    }

    if (outcome.view.status === 'authorized') {
      svc.notifyPaymentEvent('payment.authorized', outcome.view);
    } else if (outcome.view.status === 'failed') {
      svc.notifyPaymentEvent('payment.failed', outcome.view);
    }
    return outcome.view;
  });
}

/**
 * Only an authorized payment is captured. `disputed -> captured` is a legal move, but it belongs to a won dispute
 * (restoreAfterWonDispute), never to a capture call: a capture retried after a dispute opened would append a second
 * `captured` event (doubling the captured total, so the refundable amount) and read the payment as paid again.
 */
function refuseDisputedCapture(row: { id: string; status: string }): void {
  if (row.status !== 'disputed') return;
  throw new PayError(`Payment ${row.id} is disputed; only a won dispute returns it to captured`, 'pay.invalid_transition', {
    from: row.status,
    to: 'captured',
  });
}

/**
 * `authorized → captured`. THE INBOUND MONEY PATH.
 *
 * The rail moves first and the ledger books second: we only book value we
 * know has arrived.
 *
 * IF THIS CRASHES BETWEEN THE TWO, whose funds are stranded? Nobody's, but
 * they are in the wrong place for a while — captured at the rail, not yet in
 * the merchant's clearing account. The payment is still `authorized`, the
 * adapter's `capture` is idempotent, and `payment.capture:<paymentId>` means
 * the ledger post cannot double. Re-running this method finishes the job and
 * the merchant is made whole. That is the entire reason both halves are keyed
 * on the payment rather than on the attempt.
 */
export async function capture(
  svc: PayServiceInternal,
  paymentId: string,
  options: {
    amount?: Amount;
    identityAuthority?: import('@intafaced/contracts').IdentityOperationIntent['authority'];
    /** The caller's API key. A sandbox key cannot capture into the live book. */
    keyEnv?: 'sandbox';
  } = {},
): Promise<PaymentView> {
  const original = await readPayment(svc.sql, paymentId);
  if (['captured', 'settled'].includes(original.status)) return svc.getPayment(paymentId);
  // Refused before anything is admitted, and again under the payment lock below.
  refuseDisputedCapture(original);
  return withMoneySpan('pay.capture', { operation: 'capture', paymentId }, async (span) =>
    svc
      .admitPaymentOperation(
        {
          paymentId,
          merchantId: original.merchant_id,
          kind: 'payment.capture',
          authority: options.identityAuthority,
          payload: {
            paymentId,
            merchantId: original.merchant_id,
            amount: formatAmount(parseAmount(original.amount)),
            requestedAmount: options.amount === undefined ? null : formatAmount(options.amount),
            assetId: original.currency,
            railId: original.rail_adapter,
            railRef: original.rail_ref,
          },
        },
        async (tx, admitted) => {
          const observed = await readPayment(tx, paymentId);

          if (observed.status === 'captured' || observed.status === 'settled') return svc.view(tx, observed);

          // Merchant → payment is the single svc-pay money lock order. The shared
          // merchant lock (taken in admitPaymentOperation, before the guard)
          // intentionally spans the rail + ledger calls below: if released
          // earlier, a cutoff could commit after this check but before the
          // irreversible capture, recreating the stale-eligibility race.
          const row = await lockPayment(tx, paymentId);
          if (row.status === 'captured' || row.status === 'settled') return svc.view(tx, row);
          // A dispute can open between the first read and this lock.
          refuseDisputedCapture(row);
          assertTransition(row, 'captured');
          if (svc.rails.has(row.rail_adapter) && svc.rails.get(row.rail_adapter).checksPayerName) await assertNoPayerNameHold(tx, row.id);
          if (
            admitted &&
            (parseAmount(row.amount) !== parseAmount(original.amount) ||
              row.currency !== original.currency ||
              row.rail_adapter !== original.rail_adapter ||
              row.rail_ref !== original.rail_ref)
          )
            throw new PayError('Capture payload changed after admission', 'pay.identity_admission_conflict');

          const authorized = parseAmount(row.amount);

          if (options.amount !== undefined) {
            if (options.amount > authorized) {
              throw new PayError(
                `Cannot capture ${formatAmount(options.amount)} against an authorization of ${formatAmount(authorized)}`,
                'pay.capture_exceeds_authorized',
                { authorized: formatAmount(authorized), requested: formatAmount(options.amount) },
              );
            }
            if (options.amount < authorized) {
              // §6.1's interface is `capture(ref: string)` — there is nowhere to
              // put a partial amount. Refusing is honest; capturing the full
              // authorization while telling the caller we captured less is not.
              throw new PayError(
                'Partial capture is not expressible through the RailAdapter interface (§6.1) — refund the difference instead',
                'pay.partial_capture_unsupported',
                { authorized: formatAmount(authorized), requested: formatAmount(options.amount) },
              );
            }
          }

          if (!row.rail_ref) {
            throw new PayError(`Payment ${row.id} has no rail reference to capture`, 'pay.invalid_transition');
          }

          // Before the rail and before the ledger. A sandbox key's capture
          // recipe debits live clearing; refusing here posts nothing.
          svc.refuseSandboxLive(
            options.keyEnv === 'sandbox' || (await svc.paymentIsSandbox(tx, row.id)),
            recipes.paymentCapture({
              paymentId: row.id,
              merchantId: row.merchant_id,
              assetId: row.currency,
              amount: authorized,
              rail: row.rail_adapter,
              railRef: row.rail_ref,
            }),
          );

          const adapter = svc.rails.require(row.rail_adapter, 'capture');
          refuseUnusableRail(adapter, svc.now());
          const railRef = row.rail_ref;

          // The whole authorization, named: a chain address can receive more after authorize, and the rail books what it authorized.
          const result = await withRailSpan(adapter.id, 'capture', async () => adapter.capture(railRef, { authorized }));
          await appendEvent(tx, row.id, 'rail.capture', railPayload(result));

          if (!result.ok) {
            // NOT marked failed. An authorization whose capture failed is still
            // an authorization, and a retry is the normal response. Marking it
            // failed here would abandon a buyer's held funds on a transient
            // acquirer error.
            throw new PayError(result.failureReason ?? 'Rail failed to capture', 'pay.rail_failed', {
              failureCode: result.failureCode,
            });
          }

          if (result.amount !== authorized || result.assetId !== row.currency) {
            // The rail captured something other than what we authorized. Book
            // neither number: one of the two systems is wrong and guessing which
            // is how a discrepancy becomes a loss.
            throw new PayError(
              `Rail captured ${formatAmount(result.amount)} against an authorization of ${formatAmount(authorized)}`,
              'pay.rail_amount_mismatch',
              { authorized: formatAmount(authorized), captured: formatAmount(result.amount) },
            );
          }

          const posted = await postPayLedger(
            svc.ledger,
            recipes.paymentCapture({
              paymentId: row.id,
              merchantId: row.merchant_id,
              assetId: row.currency,
              amount: result.amount,
              rail: adapter.id,
              railRef: result.railRef,
            }),
          );

          // The reconciler calls this same function and does not post again.
          const view = await svc.finishBookedCapture(tx, row, {
            ledgerTxId: posted.id,
            amount: result.amount,
            railRef: result.railRef,
          });
          span.setAttribute('intafaced.amount', formatAmount(result.amount));
          return view;
        },
      )
      .then((view) => {
        if (view.status === 'captured') svc.notifyPaymentEvent('payment.captured', view);
        return view;
      }),
  );
}

/**
 * What a capture does after the ledger post has succeeded: count intake, append
 * the captured event, project the status, close the checkout. No ledger post.
 * `capture` calls it after `postPayLedger`. The authorized-capture reconciler
 * calls it when that key is already on the book.
 */
export async function finishBookedCapture(
  svc: PayServiceInternal,
  tx: Sql,
  row: PaymentRow,
  booked: BookedCaptureCompletion,
): Promise<PaymentView> {
  await svc.guards.afterPaymentCaptureBooked({
    tx,
    paymentId: row.id,
    merchantId: row.merchant_id,
    assetId: row.currency,
    amount: booked.amount,
    // Live capture omits this: the guard clock is the booking time. The reconciler
    // passes the ledger postedAt so the cap period is the booking, not the run.
    ...(booked.postedAt ? { at: booked.postedAt } : {}),
  });
  await appendEvent(tx, row.id, 'captured', {
    amount: formatAmount(booked.amount),
    railRef: booked.railRef,
    ledgerTxId: booked.ledgerTxId,
  });
  await tx`UPDATE pay.payments SET status = 'captured', updated_at = now() WHERE id = ${row.id}`;
  // Same transaction as the capture. A hosted checkout that says "paid" out of
  // step with the book is the failure this feature exists to avoid.
  await completeCheckoutSession(tx, row.id);
  return svc.view(tx, { ...row, status: 'captured' });
}

/**
 * Finish `authorized` payments whose ledger capture key already exists.
 * Does not post. `mode: 'off'` throws and reads nothing.
 */
export async function reconcileAuthorizedCaptures(
  svc: PayServiceInternal,
  input: CaptureReconcileInput,
  mode: CaptureReconcileMode,
): Promise<CaptureReconcileReport> {
  try {
    return await runCaptureReconcile(
      {
        sql: svc.sql,
        ledger: svc.ledger,
        lockMerchant: async (tx, merchantId) => {
          await svc.lockMerchantEligibility(tx, merchantId);
        },
        complete: (tx, row, booked) => svc.finishBookedCapture(tx, row as PaymentRow, booked),
        onReconciled: (view) => {
          if (view.status === 'captured') svc.notifyPaymentEvent('payment.captured', view as PaymentView);
        },
      },
      input,
      mode,
    );
  } catch (error) {
    if (error instanceof CaptureReconcileError) throw new PayError(error.message, error.code);
    throw error;
  }
}

/** What a `pending` result says has arrived so far (`raw.received`, a decimal string); none when it says nothing readable. */
function pendingReceived(result: RailResult): Amount {
  const received = result.raw?.received;
  if (typeof received !== 'string') return 0n;
  try {
    return parseAmount(received);
  } catch {
    return 0n;
  }
}
