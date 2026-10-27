/**
 * Refunds: the refund path, the settled pot it draws from, and recovery of a booked refund.
 *
 * Moved out of `payment-service.ts` as it was (owner decision 2026-10-23): `PayService` keeps one method per
 * function here, which passes itself as `svc`.
 */
import { postPayLedger } from '../ledger-receipt.js';
import { FRESH } from '../seams/guards.js';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import {
  formatAmount,
  LedgerError,
  merchantClearing,
  merchantProceeds,
  railBoundary,
  recipes,
  userAvailable,
  type Amount,
  type LedgerTx,
} from '@intafaced/ledger-client';
import { classifySettlementTx, readSettlementBook, settlementIdempotencyKey } from '../settlement-book.js';
import { type RailResult } from '../rails/rail-adapter.js';
import { assertRailMayMoveValue } from '../rails/posture.js';
import { withMoneySpan, withRailSpan } from '../tracing.js';
import type { PayService, PayServiceInternal, PaymentView } from '../payment-service.js';
import { PayError, appendEvent, countEvents, lockPayment, railPayload, readPayment, refuseUnusableRail, totalsFor } from './internal.js';

/**
 * Refund, in full or in part. THE OUTBOUND MONEY PATH.
 *
 * Merchant refund of a captured payment through ledger-client
 * (`recipes.paymentRefund`). Refuse `pay.nothing_captured` if nothing was
 * captured — before the ledger posts. No PSP. No invented dest (crypto
 * returns to the payer).
 *
 * The ledger moves FIRST, in its own committed transaction, and only then is
 * the rail asked to send money out. That order is the whole design:
 *
 *   · The merchant must be shown to have the money before any of it leaves.
 *     A post-settlement refund the merchant cannot cover fails here, at the
 *     ledger, before anything irreversible happens.
 *
 *   · IF THIS CRASHES AFTER THE LEDGER POST AND BEFORE THE RAIL CALL, nothing
 *     is stranded: the book is already correct — the merchant is debited and
 *     the value sits at the rail boundary, which is exactly what "we owe this
 *     to a buyer" means. A `refund.posted` event with no `refunded` sibling is
 *     the marker an operator reconciles from.
 *
 *   · IF THE RAIL THEN REFUSES, the ledger post is reversed and the merchant
 *     gets their money back in the same call.
 *
 * A retry of a refund id that is already in flight is REFUSED rather than
 * re-sent. The rail receives the durable `refundId` (M226-02) so live crypto
 * can journal the outbound chain send under a stable key; "send it again and
 * hope" is how one refund becomes two.
 */
export async function refund(
  svc: PayServiceInternal,
  paymentId: string,
  amount: Amount,
  options: { refundId?: string; keyEnv?: 'sandbox' } = {},
): Promise<PaymentView> {
  return withMoneySpan('pay.refund', { operation: 'refund', paymentId, amount: formatAmount(amount) }, async () =>
    svc.refundInner(paymentId, amount, options),
  );
}

export async function refundInner(
  svc: PayServiceInternal,
  paymentId: string,
  amount: Amount,
  options: { refundId?: string; keyEnv?: 'sandbox' },
): Promise<PaymentView> {
  if (amount <= 0n) throw new PayError('Refund amount must be positive', 'pay.invalid_amount');

  // ── Phase 1: debit the merchant, and commit the fact that we are about to
  // send money out. Nothing external is called inside this transaction.
  const prepared = await transaction(
    svc.sql,
    async (tx) => {
      // Seam: first thing in the transaction, before the payment row lock (a
      // guard's own locks must rank before it; seams/guards.ts) and before any
      // write, so a refusal rolls back to nothing. Reads the payment unlocked
      // for its merchant, asset and whether this refund id already completed.
      const peek = await readPayment(tx, paymentId);
      const completed =
        options.refundId !== undefined &&
        (
          await tx`
            SELECT 1 FROM pay.payment_events
             WHERE payment_id = ${peek.id} AND event = 'refunded' AND payload->>'refundId' = ${options.refundId}
             LIMIT 1
          `
        ).length > 0;
      await svc.guards.beforeRefund({
        tx,
        paymentId: peek.id,
        merchantId: peek.merchant_id,
        assetId: peek.currency,
        amount,
        refundId: options.refundId,
        replay: completed ? { kind: 'replay', reason: 'refund_already_completed' } : FRESH,
      });
      const row = await lockPayment(tx, paymentId);

      // A COMPLETED `refundId` IS A REPLAY, NOT A SECOND REFUND.
      //
      // `refundId` is a business key — it is what
      // `payment.refund:<paymentId>:<refundId>` makes the ledger idempotent
      // on. The ledger would therefore already dedupe a repeat and move
      // nothing, but the EVENT LOG would not:
      // `totalsFor` sums every `refunded` row, so appending a second one for
      // the same business key leaves the book correct and the PROJECTION
      // wrong — `refundedAmount` doubles, and refundable shrinks by a refund
      // that never happened. That desync is worse to unpick than a refusal.
      //
      // So a caller who repeats a completed refund id gets the payment as it
      // stands, having moved and recorded nothing. This is the same rule the
      // authorize path already states as "an authorization that already
      // happened is not an error", and it is what makes it safe for
      // `public-rest.ts` to derive this id from the caller's Idempotency-Key.
      //
      // Checked FIRST, before every status and balance check, deliberately: a
      // FULL refund moves the payment to `refunded` and its refundable balance to
      // zero, so a retry of the same id (a lost reply, or a concurrent retry that
      // takes the row lock after the winner recorded the refund) would otherwise
      // be refused `pay.nothing_captured` or `pay.refund_exceeds_captured` for a
      // refund that succeeded, and a merchant told "refused" may send a second
      // refund under a new id.
      //
      // Only for an EXPLICIT id. The `${paymentId}:${sequence + 1}` default is
      // a fresh ordinal by construction and can never be a replay of itself.
      if (options.refundId !== undefined) {
        // A COMPLETED refundId is one business event with ONE amount.
        // Same id + same amount → replay (no second movement / event).
        // Same id + different amount → conflict: silent 200 with the old
        // amount would teach the merchant their second request succeeded.
        const alreadyDone = await tx<Array<{ amount: string | null }>>`
          SELECT payload->>'amount' AS amount
            FROM pay.payment_events
           WHERE payment_id = ${row.id}
             AND event = 'refunded'
             AND payload->>'refundId' = ${options.refundId}
           LIMIT 1
        `;
        if (alreadyDone[0]) {
          const prior = alreadyDone[0].amount;
          if (prior !== null && prior !== formatAmount(amount)) {
            throw new PayError(
              `Refund id ${options.refundId} already completed for ${prior}; requested ${formatAmount(amount)} — use a new refundId for a different amount`,
              'pay.refund_id_conflict',
              {
                refundId: options.refundId,
                paymentId: row.id,
                completedAmount: prior,
                requested: formatAmount(amount),
              },
            );
          }
          return { replay: true as const, view: await svc.view(tx, row) };
        }
      }

      if (row.status !== 'captured' && row.status !== 'settled') {
        throw new PayError(`Payment ${row.id} has nothing captured (status ${row.status}) — refund refused`, 'pay.nothing_captured', {
          paymentId: row.id,
          status: row.status,
        });
      }

      // Pre-settlement only: a pending settlement freeze has claimed this
      // payment's clearing. Refunding from clearing under a frozen gross is
      // how another payment's capture funds the window (or the post sticks
      // forever on insufficient clearing). After the window posts the status
      // is `settled` and the refund draws on available instead — allowed.
      if (row.status === 'captured') {
        const pendingSettlement = await tx<Array<{ settlement_id: string }>>`
          SELECT e.payload->>'settlementId' AS settlement_id
            FROM pay.payment_events e
            JOIN pay.settlements s ON s.id = (e.payload->>'settlementId')::uuid
           WHERE e.payment_id = ${row.id}
             AND e.event = 'settlement.included'
             AND s.status = 'pending'
           LIMIT 1
        `;
        if (pendingSettlement[0]) {
          throw new PayError(
            `Payment ${row.id} is frozen in pending settlement ${pendingSettlement[0].settlement_id} — wait for the window to post, then refund from the merchant balance`,
            'pay.settlement_in_flight',
            { settlementId: pendingSettlement[0].settlement_id, paymentId: row.id },
          );
        }
      }

      const totals = await totalsFor(tx, row.id);
      if (totals.captured <= 0n) {
        throw new PayError(`Payment ${row.id} has nothing captured — refund refused`, 'pay.nothing_captured', { paymentId: row.id });
      }

      // A completed `refundId` was answered above, before the status checks.
      if (options.refundId !== undefined) {
        // Spent after reverse: ledger key will no-op; rail may still pay.
        // A genuine re-attempt needs a new refundId (public REST: new
        // Idempotency-Key → new restRefundId).
        const spent = await tx<Array<{ n: string }>>`
          SELECT COUNT(*)::text AS n
            FROM pay.payment_events
           WHERE payment_id = ${row.id}
             AND event = 'refund.reversed'
             AND payload->>'refundId' = ${options.refundId}
        `;
        if (Number.parseInt(spent[0]?.n ?? '0', 10) > 0) {
          throw new PayError(
            `Refund id ${options.refundId} was already used and reversed — supply a new refundId for a genuine re-attempt`,
            'pay.refund_id_spent',
            { refundId: options.refundId, paymentId: row.id },
          );
        }
      }

      const refundable = totals.captured - totals.refunded;
      if (amount > refundable) {
        throw new PayError(
          `Refundable balance is ${formatAmount(refundable)}, requested ${formatAmount(amount)}`,
          'pay.refund_exceeds_captured',
          { refundable: formatAmount(refundable), requested: formatAmount(amount) },
        );
      }

      const inFlight = await tx<Array<{ refund_id: string; amount: string | null; source: string | null }>>`
        SELECT p.payload->>'refundId' AS refund_id, p.payload->>'amount' AS amount, p.payload->>'source' AS source
          FROM pay.payment_events p
         WHERE p.payment_id = ${row.id} AND p.event = 'refund.posted'
           AND NOT EXISTS (
             SELECT 1 FROM pay.payment_events d
              WHERE d.payment_id = p.payment_id
                AND d.event IN ('refunded', 'refund.reversed')
                AND d.payload->>'refundId' = p.payload->>'refundId'
           )
      `;
      if (inFlight.length > 0) {
        const pending = inFlight[0]!;
        // The same explicit refund id, asked again, is the retry of a refund whose rail reply was lost. The ledger
        // already moved and says so (`refund.posted`), so book nothing: resume at the rail with the same id. Only a
        // rail that answers a repeated id with its first result may be asked again; on any other this stays in flight
        // for someone to reconcile, because asking it again could pay twice.
        const resumable =
          options.refundId !== undefined &&
          inFlight.length === 1 &&
          pending.refund_id === options.refundId &&
          svc.rails.require(row.rail_adapter, 'refund').refundIsIdempotentByRefundId === true;
        if (!resumable) {
          throw new PayError(
            `Refund ${pending.refund_id} is already in flight — reconcile it against the rail before refunding again`,
            'pay.refund_in_flight',
            { refundId: pending.refund_id },
          );
        }
        if (pending.amount !== formatAmount(amount)) {
          throw new PayError(
            `Refund id ${pending.refund_id} is in flight for ${pending.amount}; requested ${formatAmount(amount)} — use a new refundId for a different amount`,
            'pay.refund_id_conflict',
            { refundId: pending.refund_id, paymentId: row.id, inFlightAmount: pending.amount, requested: formatAmount(amount) },
          );
        }
        const resumedMerchant = await svc.getMerchant(row.merchant_id);
        const resumedSource = pending.source === 'settled' ? ('settled' as const) : ('clearing' as const);
        return {
          replay: false as const,
          row,
          refundId: pending.refund_id,
          source: resumedSource,
          settledPot:
            resumedSource === 'settled' ? await svc.settledPotForPayment(tx, row.id, resumedMerchant.userId) : ('proceeds' as const),
          merchant: resumedMerchant,
          captured: totals.captured,
          refunded: totals.refunded,
        };
      }

      // BEFORE THE LEDGER MOVES, not at the rail call in Phase 2. This
      // transaction is about to debit the merchant and commit "a refund is on
      // its way out"; refusing after that leaves a `refund.posted` event with
      // no rail behind it, which is the `pay.refund_in_flight` state — and that
      // state deliberately blocks every further refund on the payment until an
      // operator reconciles it. A refusal that was knowable here must not cost
      // the merchant that.
      const refundRail = svc.rails.require(row.rail_adapter, 'refund');
      assertRailMayMoveValue(refundRail, 'refund', svc.valueMovement);
      refuseUnusableRail(refundRail, svc.now());

      const sequence = await countEvents(tx, row.id, 'refund.posted');
      const refundId = options.refundId ?? `${row.id}:${sequence + 1}`;
      const merchant = await svc.getMerchant(row.merchant_id);
      let source = row.status === 'settled' ? ('settled' as const) : ('clearing' as const);
      let settledPot: 'proceeds' | 'user' = source === 'settled' ? await svc.settledPotForPayment(tx, row.id, merchant.userId) : 'proceeds';
      const refundRequest = (from: 'clearing' | 'settled', pot: 'proceeds' | 'user') =>
        recipes.paymentRefund({
          refundId,
          paymentId: row.id,
          merchantId: row.merchant_id,
          merchantUserId: merchant.userId,
          assetId: row.currency,
          amount,
          rail: row.rail_adapter,
          source: from,
          ...(from === 'settled' && pot === 'user' ? { settledPot: 'user' as const } : {}),
        });

      let posted: LedgerTx;
      svc.refuseSandboxLive(options.keyEnv === 'sandbox' || (await svc.paymentIsSandbox(tx, row.id)), refundRequest(source, settledPot));
      try {
        posted = await postPayLedger(svc.ledger, refundRequest(source, settledPot));
      } catch (error) {
        // `source` is derived from the payment's CURRENT status, but the ledger key
        // `payment.refund:<paymentId>:<refundId>` does not contain it and it decides which account is debited. If an
        // earlier attempt booked this refund and its reply was lost (timeout, deadline, unreadable acknowledgement) the
        // transaction rolled back with no `refund.posted`; the payment may have settled since, so this attempt asks for
        // the other account. The ledger then answers with the ORIGINAL booking (or refuses the key) and every retry
        // would fail, while a new refundId would debit the merchant twice. Recover only that case: the booked
        // transaction is read back, checked leg by leg, and its own source is adopted.
        const recovered = await svc.recoverBookedRefund(error, {
          key: refundRequest(source, settledPot).idempotencyKey,
          paymentId: row.id,
          refundId,
          merchantId: row.merchant_id,
          merchantUserId: merchant.userId,
          assetId: row.currency,
          rail: row.rail_adapter,
          amount,
        });
        if (!recovered) throw error;
        posted = recovered.tx;
        source = recovered.source;
        settledPot = recovered.settledPot;
      }

      await appendEvent(tx, row.id, 'refund.posted', {
        refundId,
        amount: formatAmount(amount),
        source,
        ledgerTxId: posted.id,
      });

      return {
        replay: false as const,
        row,
        refundId,
        source,
        settledPot,
        merchant,
        captured: totals.captured,
        refunded: totals.refunded,
      };
    },
    { isolation: 'read committed', maxAttempts: 5 },
  );

  // A repeat of a completed refund id. Nothing moved, nothing was appended,
  // and no rail was asked — the payment is returned exactly as it stands.
  if (prepared.replay) return prepared.view;

  // ── Phase 2: send it. The book already says this money is on its way out.
  const adapter = svc.rails.require(prepared.row.rail_adapter, 'refund');
  const railRef = prepared.row.rail_ref!;
  let result: RailResult;
  try {
    result = await withRailSpan(adapter.id, 'refund', async () => adapter.refund(railRef, amount, { refundId: prepared.refundId }));
  } catch (error) {
    // The book already says the refund is on its way out. Counting may halt
    // later payouts. It does not reverse, replay, or replace this throw.
    await svc.accountRailOutcome({
      kind: 'throw',
      target: { level: 'merchant', merchantId: prepared.row.merchant_id },
      railId: prepared.row.rail_adapter,
    });
    throw error;
  }

  // ── Phase 3: record what the rail did, and reverse the ledger if it refused.
  const settled = await transaction(
    svc.sql,
    async (tx) => {
      const row = await lockPayment(tx, paymentId);
      // A resumed refund can reach here twice (two retries of the same id). The first to commit decides; the other
      // records nothing and answers with the same outcome.
      const decided = await tx<Array<{ event: string }>>`
        SELECT event FROM pay.payment_events
         WHERE payment_id = ${row.id} AND event IN ('refunded', 'refund.reversed')
           AND payload->>'refundId' = ${prepared.refundId}
         LIMIT 1
      `;
      if (decided[0]) return { ok: decided[0].event === 'refunded', view: await svc.view(tx, row) };
      await appendEvent(tx, row.id, 'rail.refund', { ...railPayload(result), refundId: prepared.refundId });

      const refundInput = {
        refundId: prepared.refundId,
        paymentId: row.id,
        merchantId: row.merchant_id,
        merchantUserId: prepared.merchant.userId,
        assetId: row.currency,
        amount,
        rail: row.rail_adapter,
        source: prepared.source,
        ...(prepared.source === 'settled' && prepared.settledPot === 'user' ? { settledPot: 'user' as const } : {}),
      };

      if (!result.ok) {
        // Put the merchant's money back. Its own business key, so a retry of
        // the reversal finds the reversal rather than the refund.
        svc.refuseSandboxLive(await svc.paymentIsSandbox(tx, row.id), recipes.paymentRefundReverse(refundInput));
        await postPayLedger(svc.ledger, recipes.paymentRefundReverse(refundInput));
        await appendEvent(tx, row.id, 'refund.reversed', {
          refundId: prepared.refundId,
          amount: formatAmount(amount),
          failureCode: result.failureCode ?? 'rail.failed',
        });
        // Recorded, then thrown OUTSIDE this transaction. Throwing here would
        // roll back the very event that says the reversal happened, and the
        // next refund attempt would see a refund still in flight.
        return { ok: false as const, view: await svc.view(tx, row) };
      }

      await appendEvent(tx, row.id, 'refunded', {
        refundId: prepared.refundId,
        amount: formatAmount(amount),
        source: prepared.source,
        railRef: result.railRef,
      });

      if (prepared.refunded + amount >= prepared.captured) {
        await tx`UPDATE pay.payments SET status = 'refunded', updated_at = now() WHERE id = ${row.id}`;
        return { ok: true as const, view: await svc.view(tx, { ...row, status: 'refunded' }) };
      }

      // Partially refunded. The status stays where it was: the merchant is
      // still owed the remainder, and a settlement sweep must still see it.
      return { ok: true as const, view: await svc.view(tx, row) };
    },
    { isolation: 'read committed', maxAttempts: 5 },
  );

  if (!settled.ok) {
    await svc.accountRailOutcome({
      kind: 'failure',
      target: { level: 'merchant', merchantId: prepared.row.merchant_id },
      railId: prepared.row.rail_adapter,
      failureCode: result.failureCode,
      eventKey: `refund:${prepared.row.id}:${prepared.refundId}`,
    });
    throw new PayError(result.failureReason ?? 'Rail refused the refund', 'pay.rail_failed', {
      failureCode: result.failureCode,
      refundId: prepared.refundId,
    });
  }

  await svc.accountRailOutcome({
    kind: 'success',
    target: { level: 'merchant', merchantId: prepared.row.merchant_id },
    railId: prepared.row.rail_adapter,
  });
  svc.notifyPaymentEvent('payment.refunded', settled.view);
  return settled.view;
}

/**
 * The pot a settled payment's own settlement post debited.
 * No settled event, or a post that is neither legacy nor proceeds, refuses.
 */
export async function settledPotForPayment(
  svc: PayServiceInternal,
  sql: Sql,
  paymentId: string,
  merchantUserId: string,
): Promise<'proceeds' | 'user'> {
  const rows = await sql<Array<{ settlement_id: string | null }>>`
    SELECT payload->>'settlementId' AS settlement_id
      FROM pay.payment_events
     WHERE payment_id = ${paymentId} AND event = 'settled'
     ORDER BY seq DESC
     LIMIT 1
  `;
  const settlementId = rows[0]?.settlement_id;
  if (!settlementId) {
    throw new PayError(`Payment ${paymentId} has no settlement post to draw a settled refund from`, 'pay.settlement_book_unrecognised', {
      paymentId,
    });
  }
  const settlement = await svc.getSettlement(settlementId, sql);
  const book = await readSettlementBook(svc.ledger, {
    merchantId: settlement.merchantId,
    merchantUserId,
    window: settlement.window,
    assetId: settlement.assetId,
  });
  if (book === 'legacy') return 'user';
  if (book === 'proceeds') return 'proceeds';
  throw new PayError(`Payment ${paymentId} settlement book is not recognised`, 'pay.settlement_book_unrecognised', {
    paymentId,
    settlementId,
  });
}

/**
 * The pot a chargeback's settled leg uses.
 *
 * A `settled` event means this payment's own settlement post already chose
 * the pot. Current status does not: `markDisputed` runs before the opening
 * on the operator route, and a stored-plan replay, a won return, and a lost
 * close must name the same pot or they post a different body under the
 * dispute key. No settled event means the money is still in clearing, and
 * the settled leg (if any) is proceeds.
 */
export async function chargebackSettledPot(
  svc: PayServiceInternal,
  paymentId: string,
  merchantUserId: string,
): Promise<'proceeds' | 'user'> {
  const settled = await svc.sql<Array<{ ok: number }>>`
    SELECT 1 AS ok FROM pay.payment_events
     WHERE payment_id = ${paymentId} AND event = 'settled'
     LIMIT 1
  `;
  if (settled.length === 0) return 'proceeds';
  return svc.settledPotForPayment(svc.sql, paymentId, merchantUserId);
}

/**
 * The book a payout may draw. Absent or unrecognised refuses before any
 * admission row exists, so treasury exposure does not keep a pending payout
 * the rail will never be asked to send.
 */
/**
 * A payment stays `disputed` after a lost or accepted case, so the status alone cannot tell an open
 * dispute from a closed one. Only an open or contested case (or a disputed payment with no case row
 * yet) can still hand money back.
 */
export async function hasUnresolvedDispute(svc: PayServiceInternal, sql: Sql, merchantId: string, assetId: string): Promise<boolean> {
  const disputed = await sql<Array<{ id: string }>>`
    SELECT id FROM pay.payments
     WHERE merchant_id = ${merchantId}::uuid AND currency = ${assetId} AND status = 'disputed'
  `;
  for (const { id } of disputed) {
    const cases = await svc.disputeCases.listForPayment(id);
    if (cases.length === 0 || cases.some((c) => c.status === 'open' || c.status === 'contested')) return true;
  }
  return false;
}

export async function recognisedPayoutBook(
  svc: PayServiceInternal,
  input: {
    settlementId: string;
    merchantId: string;
    merchantUserId: string;
    window: string;
    assetId: string;
  },
): Promise<'legacy' | 'proceeds'> {
  const settlementTx = await svc.ledger.getTxByKey(settlementIdempotencyKey(input.merchantId, input.window, input.assetId));
  if (!settlementTx) {
    throw new PayError(`Settlement ${input.settlementId} has no settlement post`, 'pay.settlement_book_unrecognised', {
      settlementId: input.settlementId,
    });
  }
  const book = await classifySettlementTx(svc.ledger, settlementTx, {
    merchantId: input.merchantId,
    merchantUserId: input.merchantUserId,
    assetId: input.assetId,
  });
  if (book === 'legacy' || book === 'proceeds') return book;
  throw new PayError(`Settlement ${input.settlementId} ledger post is not a recognised settlement`, 'pay.settlement_book_unrecognised', {
    settlementId: input.settlementId,
  });
}

/**
 * A refund whose first attempt was booked by svc-ledger but never acknowledged to us (see the phase-1 call).
 *
 * Returns the booked transaction and the source it was booked from, when `error` is a receipt mismatch or an
 * idempotency refusal AND the ledger really holds this refund key with exactly the two legs `paymentRefund` books:
 * the merchant account (clearing, proceeds, or the pre-cutover user available) credited and the rail boundary debited,
 * in this asset. A booking for a different amount is a refund id reused for another refund (`pay.refund_id_conflict`).
 * Anything else, including nothing booked, returns null so the caller rethrows the original error.
 */
export async function recoverBookedRefund(
  svc: PayServiceInternal,
  error: unknown,
  input: {
    key: string;
    paymentId: string;
    refundId: string;
    merchantId: string;
    merchantUserId: string;
    assetId: string;
    rail: string;
    amount: Amount;
  },
): Promise<{ tx: LedgerTx; source: 'clearing' | 'settled'; settledPot: 'proceeds' | 'user' } | null> {
  if (!(error instanceof LedgerError) || (error.code !== 'pay.ledger_receipt_mismatch' && error.code !== 'ledger.idempotency_conflict')) {
    return null;
  }
  const booked = await svc.ledger.getTxByKey(input.key);
  if (!booked || booked.module !== 'pay' || booked.reason !== 'payment.refunded' || booked.entries.length !== 2) return null;
  const credit = booked.entries.find((e) => e.direction === 'credit');
  const debit = booked.entries.find((e) => e.direction === 'debit');
  if (!credit || !debit || credit.assetId !== input.assetId || debit.assetId !== input.assetId || credit.amount !== debit.amount)
    return null;

  const boundary = (await svc.ledger.balance(railBoundary(input.rail, input.assetId))).accountId;
  if (!boundary || debit.accountId !== boundary) return null;
  const clearing = (await svc.ledger.balance(merchantClearing(input.merchantId, input.assetId))).accountId;
  const proceeds = (await svc.ledger.balance(merchantProceeds(input.merchantId, input.assetId))).accountId;
  const personal = (await svc.ledger.balance(userAvailable(input.merchantUserId, input.assetId))).accountId;
  const settledPot: 'proceeds' | 'user' = personal !== '' && credit.accountId === personal ? 'user' : 'proceeds';
  const source =
    credit.accountId === clearing
      ? ('clearing' as const)
      : credit.accountId === proceeds || settledPot === 'user'
        ? ('settled' as const)
        : null;
  if (!source) return null;

  if (credit.amount !== input.amount) {
    throw new PayError(
      `Refund id ${input.refundId} is already booked for ${formatAmount(credit.amount)}; requested ${formatAmount(input.amount)} — use a new refundId for a different amount`,
      'pay.refund_id_conflict',
      {
        refundId: input.refundId,
        paymentId: input.paymentId,
        completedAmount: formatAmount(credit.amount),
        requested: formatAmount(input.amount),
      },
    );
  }
  return { tx: booked, source, settledPot: source === 'settled' ? settledPot : 'proceeds' };
}
