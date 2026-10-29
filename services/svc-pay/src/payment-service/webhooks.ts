/**
 * Rail webhooks and the payment states they move: failed, disputed, and restored after a won dispute.
 *
 * Moved out of `payment-service.ts` as it was (owner decision 2026-10-23): `PayService` keeps one method per
 * function here, which passes itself as `svc`.
 */
import { transaction } from '@intafaced/db';
import { formatAmount } from '@intafaced/ledger-client';
import { type RailAdapter, type RailEvent, type RailWebhookRequest } from '../rails/rail-adapter.js';
import { type ChargebackLedgerEffect } from '../chargeback-ledger-effect.js';
import { recordRailDisputeDeadline } from '../merchant-ops/dispute-deadlines.js';
import { withMoneySpan } from '../tracing.js';
import {
  DisputeCaseError,
  isTerminalDisputeStatus,
  railOutcomeConflicts,
  refuseChargebackNothingToReverse,
  type RailResolutionOutcome,
} from '../fraud/dispute-case.js';
import { recordDisputeOutcomeConflict } from '../fraud/dispute-outcome-conflict.js';
import type { PayService, PayServiceInternal, PaymentRow, PaymentStatus, PaymentView, WebhookOutcome } from '../payment-service.js';
import { PayError, appendEvent, assertTransition, lockPayment } from './internal.js';
import { payerNameHoldOf } from '../payer-name/holds.js';
import { fundsHeldOf, recordFundsAvailable, recordFundsPending } from './funds.js';

// ── Webhooks ───────────────────────────────────────────────────────────────

/**
 * Handle an inbound webhook.
 *
 * A PSP webhook WILL be delivered twice. The second delivery must change
 * NOTHING, and that is guaranteed at the database level rather than in this
 * method: `payment_events.rail_event_id` is unique, the insert is
 * `ON CONFLICT DO NOTHING`, and a delivery that inserts no row returns
 * `duplicate: true` without going near a rail or the ledger.
 *
 * THE EFFECT IS APPLIED BEFORE THE DEDUPE MARKER IS WRITTEN, not after. Write
 * the marker first and a crash in between leaves a delivery permanently
 * recorded as seen and never acted on — a captured payment nobody ever books.
 * This way the worst case is that a redelivery re-applies an effect that is
 * already idempotent on the payment id, which costs a wasted call and
 * changes nothing.
 */
export async function handleWebhook(svc: PayServiceInternal, railId: string, request: RailWebhookRequest): Promise<WebhookOutcome> {
  const adapter = svc.rails.require(railId, 'webhook');

  const event = adapter.verifyWebhook(request);
  if (!event) {
    // Deliberately uninformative to the caller. A verification endpoint that
    // explains WHY it rejected something is an oracle for forging the next
    // attempt.
    throw new PayError('Webhook signature verification failed', 'pay.webhook_invalid', { railId });
  }

  return withMoneySpan('pay.webhook', { operation: 'webhook', rail: railId, railRef: event.railRef }, async () =>
    svc.applyWebhook(adapter, event),
  );
}

export async function applyWebhook(svc: PayServiceInternal, adapter: RailAdapter, event: RailEvent): Promise<WebhookOutcome> {
  const rows = await svc.sql<PaymentRow[]>`
    SELECT id, merchant_id, profile_id, amount, currency, method, rail_adapter, rail_ref, status, created_at
      FROM pay.payments WHERE rail_adapter = ${adapter.id} AND rail_ref = ${event.railRef}
  `;
  const payment = rows[0];

  if (!payment) {
    // An inbound to a customer deposit address has no payment. The deposit record books it (once, by chain position);
    // anything else stays unmatched below.
    const chain = event.chain;
    if (svc.custodyDeposits && event.type === 'captured' && chain && event.amount !== undefined && event.assetId) {
      const received = await svc.custodyDeposits.receive({
        address: event.railRef,
        txHash: chain.txHash,
        outputIndex: chain.logIndex,
        assetId: event.assetId,
        amount: event.amount,
        confirmations: chain.confirmations,
      });
      if (received.state === 'recorded') {
        return { railId: adapter.id, eventId: event.eventId, type: event.type, duplicate: false, paymentId: null, applied: true };
      }
    }
    if (svc.custodyDeposits?.reverse && event.type === 'chain.reorged' && chain) {
      const reversed = await svc.custodyDeposits.reverse({ address: event.railRef, txHash: chain.txHash, outputIndex: chain.logIndex });
      // A reorg of a transfer this address never recorded takes nothing back: answered, not acted on, so the watcher stops.
      if (reversed.state !== 'unmatched') {
        const applied = reversed.state === 'recorded';
        return { railId: adapter.id, eventId: event.eventId, type: event.type, duplicate: false, paymentId: null, applied };
      }
    }
    // A verified event about a payment we have no record of. Rejecting is
    // right — inventing a payment row from a webhook is how a rail's bug
    // becomes our liability — but it is also an operator signal, not a
    // client error.
    throw new PayError(`No payment for ${adapter.id} reference ${event.railRef}`, 'pay.webhook_unmatched', {
      railId: adapter.id,
      railRef: event.railRef,
      eventId: event.eventId,
    });
  }

  // A chain reorg names a payment address: nothing here acts on it, and it is not recorded as handled, so it stays an
  // operator signal (a 202 the route logs) and a redelivery is seen again, as it was before the type existed.
  if (event.type === 'chain.reorged') {
    throw new PayError(`Chain reorg for ${adapter.id} payment ${payment.id} is not acted on`, 'pay.webhook_unmatched', {
      railId: adapter.id,
      railRef: event.railRef,
      eventId: event.eventId,
    });
  }

  // Namespaced by rail. Two rails can and will use the same event id string,
  // and an unqualified collision would silently mark a genuine delivery a
  // duplicate — a captured payment nobody ever books.
  const deliveryKey = `${adapter.id}:${event.eventId}`;

  // The fast path, and the one the test "a webhook delivered twice changes
  // nothing" exercises: a delivery we have already recorded stops here,
  // before any rail call and before the ledger.
  const seen = await svc.sql<Array<{ id: string }>>`
    SELECT id FROM pay.payment_events WHERE rail_event_id = ${deliveryKey}
  `;
  if (seen.length > 0) {
    return { railId: adapter.id, eventId: event.eventId, type: event.type, duplicate: true, paymentId: payment.id, applied: false };
  }

  // The effect. Every one of these is idempotent on the payment id, which is
  // what makes it safe to apply before the marker is written — and safe for
  // two concurrent deliveries of the same event to race here.
  let applied = false;
  // RC-merchant-09: on a rail that checks the sending name, `authorize` holds the payment instead of authorizing when a
  // counted transfer's name fails the owner's rule. A delivery for a held payment is handled: recorded, nothing more.
  const nameHeld = async () => adapter.checksPayerName === true && (await payerNameHoldOf(svc.sql, payment.id)) !== null;
  const takeIn = event.type === 'authorized' || event.type === 'captured';
  if (takeIn && payment.status === 'created' && (await nameHeld())) {
    applied = true;
  } else
    switch (event.type) {
      case 'authorized':
        if (payment.status === 'created') {
          if ((await svc.authorize(payment.id)).status === 'created') {
            if (!(await nameHeld())) return stillPending(adapter, event, payment.id);
          }
          applied = true;
        }
        break;
      case 'captured':
        if (payment.status === 'authorized') {
          await svc.capture(payment.id);
          applied = true;
        } else if (payment.status === 'created') {
          // Some rails announce authorization and capture in one delivery.
          if ((await svc.authorize(payment.id)).status === 'created') {
            if (!(await nameHeld())) return stillPending(adapter, event, payment.id);
          } else await svc.capture(payment.id);
          applied = true;
        }
        break;
      case 'failed':
        if (payment.status === 'created' || payment.status === 'authorized') {
          await svc.markFailed(payment.id, event.failureCode ?? 'rail.failed');
          applied = true;
        }
        break;
      case 'funds.available':
      case 'funds.pending': {
        // RC-merchant-10: the rail's word on held funds, recorded on the payment under its lock. Only this verified
        // delivery (or the capture result) writes it; a client never does. A payment the rail never held, or one
        // already released, records the delivery and changes nothing.
        applied = await transaction(svc.sql, async (tx) => {
          const locked = await lockPayment(tx, payment.id);
          if (locked.status !== 'captured') return false;
          const state = await fundsHeldOf(tx, payment.id);
          if (!state.held) return false;
          if (event.type === 'funds.available')
            await recordFundsAvailable(tx, payment.id, { at: event.occurredAt, railEventId: deliveryKey });
          else
            await recordFundsPending(tx, payment.id, {
              ...(event.availableOn ? { availableOn: event.availableOn } : {}),
              source: 'rail.webhook',
              railEventId: deliveryKey,
            });
          return true;
        });
        break;
      }
      case 'refunded':
      case 'payout.completed':
        // Recorded, not acted on. A refund we did not initiate, or a payout the
        // rail is confirming, both need a human decision — acting on either
        // automatically would move money on a rail's say-so alone.
        break;
      case 'dispute.opened': {
        // Post the opening recipe via ledger-client, or named refuse. Never claim
        // posted without a tx id. An unfunded shortfall is a named refuse: the
        // dispute is still recorded and a later lost or closed delivery can book it.
        const disputeId = event.disputeId?.trim();
        if (disputeId) {
          const amount = event.amount === undefined ? payment.amount : formatAmount(event.amount);
          const assetId = event.assetId ?? payment.currency;
          await svc.withChargebackOutcomeLock(disputeId, async () => {
            const current = await svc.disputeCases.get(disputeId);
            // A late open must not debit a dispute that already closed.
            if (current && isTerminalDisputeStatus(current.status)) {
              applied = true;
              return;
            }
            const wire = await svc.postChargebackOpenOrRefuse({
              disputeId,
              paymentId: payment.id,
              merchantId: payment.merchant_id,
              amount,
              assetId,
            });
            const mark = {
              disputeId,
              reasonCode: event.reasonCode ?? null,
              ledgerWire: wire.ledgerPost ? ('posted' as const) : ('refused' as const),
              ledgerTxId: wire.ledgerPost?.txId ?? null,
            };
            // The status read at the top of this delivery can be stale: another dispute's win may restore the payment
            // meanwhile. Read it fresh here, and again once the case row exists (see restoreAfterWonDispute).
            const marked = await svc.markDisputedIfLive(payment.id, mark);
            await svc.disputeCases.open({
              disputeId,
              paymentId: payment.id,
              merchantId: payment.merchant_id,
              amount,
              assetId,
              reasonCode: event.reasonCode ?? null,
              paymentMarkedDisputed: marked,
              ledgerPost: wire.ledgerPost,
              ledgerRefuse: wire.ledgerRefuse,
            });
            await svc.markDisputedIfLive(payment.id, mark);
            await recordRailDisputeDeadline(svc.sql, {
              merchantId: payment.merchant_id,
              disputeId,
              evidenceDueBy: event.evidenceDueBy ?? null,
              railEventId: deliveryKey,
            });
            applied = true;
          });
        }
        break;
      }
      case 'dispute.won':
      case 'dispute.lost':
      case 'dispute.closed': {
        // Lost and closed finalise the opening debit (clearing, then merchant
        // balance, then the recipe's shortfall). Won reverses a debit that was
        // already booked. A ledger error throws before the case moves.
        const disputeId = event.disputeId?.trim();
        if (disputeId) {
          const outcome: RailResolutionOutcome = event.type === 'dispute.won' ? 'won' : event.type === 'dispute.lost' ? 'lost' : 'closed';
          const amountExplicit = event.amount !== undefined;
          const assetId = event.assetId ?? payment.currency;
          try {
            await svc.withChargebackOutcomeLock(disputeId, async () => {
              const current = await svc.disputeCases.get(disputeId);
              const amount = event.amount !== undefined ? formatAmount(event.amount) : current ? current.amount : payment.amount;
              if (current && isTerminalDisputeStatus(current.status) && railOutcomeConflicts(current.status, outcome)) {
                await recordDisputeOutcomeConflict(svc.sql, {
                  merchantId: payment.merchant_id,
                  disputeId,
                  railEventId: deliveryKey,
                  railId: adapter.id,
                  storedStatus: current.status,
                  outcome,
                });
              } else {
                let booked: ChargebackLedgerEffect;
                try {
                  booked = await svc.bookDisputeResolution({
                    disputeId,
                    paymentId: payment.id,
                    merchantId: payment.merchant_id,
                    amount,
                    assetId,
                    outcome,
                    amountExplicit,
                  });
                } catch (err) {
                  if (!(err instanceof PayError) || err.code !== 'pay.chargeback_plan_conflict') throw err;
                  await svc.recordChargebackPlanConflict({
                    merchantId: payment.merchant_id,
                    disputeId,
                    paymentId: payment.id,
                    amount,
                    assetId,
                    reasonCode: event.reasonCode ?? null,
                    railEventId: deliveryKey,
                    railId: adapter.id,
                    storedStatus: current?.status ?? 'open',
                    outcome,
                    evidenceDueBy: event.evidenceDueBy ?? null,
                  });
                  applied = true;
                  return;
                }
                if (!current) {
                  const txId = booked.openingTxId ?? booked.shortfallTxId ?? booked.wonTxId ?? booked.recoveredTxId;
                  await svc.disputeCases.open({
                    disputeId,
                    paymentId: payment.id,
                    merchantId: payment.merchant_id,
                    amount,
                    assetId,
                    reasonCode: event.reasonCode ?? null,
                    paymentMarkedDisputed: false,
                    ...(txId
                      ? { ledgerPost: { txId } }
                      : { ledgerRefuse: refuseChargebackNothingToReverse({ disputeId, paymentId: payment.id }) }),
                  });
                }
                if (payment.status === 'settled' || payment.status === 'captured') {
                  await svc.markDisputed(payment.id, {
                    disputeId,
                    reasonCode: event.reasonCode ?? null,
                    ledgerWire: booked.openingTxId || booked.shortfallTxId ? 'posted' : 'refused',
                    ledgerTxId: booked.openingTxId ?? booked.shortfallTxId,
                  });
                }
                await svc.disputeCases.applyRailResolution({
                  disputeId,
                  railEventId: deliveryKey,
                  outcome,
                });
                if (outcome === 'won') await svc.restoreAfterWonDispute(payment.id, disputeId);
              }
              await recordRailDisputeDeadline(svc.sql, {
                merchantId: payment.merchant_id,
                disputeId,
                evidenceDueBy: event.evidenceDueBy ?? null,
                railEventId: deliveryKey,
              });
              applied = true;
            });
          } catch (err) {
            // A closed case stays closed. A different later outcome is recorded
            // for founders and this delivery still succeeds, so the rail does
            // not retry a refusal it cannot repair. A ledger refusal is not that
            // case: it propagates and the dispute row stays where it was.
            if (!(err instanceof DisputeCaseError) || err.code !== 'pay.dispute_closed') throw err;
            const current = await svc.disputeCases.get(disputeId);
            if (!current || !isTerminalDisputeStatus(current.status)) throw err;
            if (railOutcomeConflicts(current.status, outcome)) {
              await recordDisputeOutcomeConflict(svc.sql, {
                merchantId: payment.merchant_id,
                disputeId,
                railEventId: deliveryKey,
                railId: adapter.id,
                storedStatus: current.status,
                outcome,
              });
            }
            applied = true;
          }
        }
        break;
      }
    }

  // The dedupe marker, written last. `ON CONFLICT DO NOTHING` because two
  // concurrent deliveries of one event both get here; the loser reports the
  // duplicate and neither has done anything twice.
  const claimed = await svc.sql<Array<{ id: string }>>`
    INSERT INTO pay.payment_events (payment_id, event, payload, rail_event_id)
    VALUES (
      ${payment.id}, ${`webhook.${event.type}`},
      ${svc.sql.json({
        type: event.type,
        railRef: event.railRef,
        amount: event.amount === undefined ? null : formatAmount(event.amount),
        assetId: event.assetId ?? null,
        occurredAt: event.occurredAt.toISOString(),
        failureCode: event.failureCode ?? null,
      } as never)},
      ${deliveryKey}
    )
    ON CONFLICT ("rail_event_id") WHERE "rail_event_id" IS NOT NULL DO NOTHING
    RETURNING id
  `;

  return {
    railId: adapter.id,
    eventId: event.eventId,
    type: event.type,
    duplicate: claimed.length === 0,
    paymentId: payment.id,
    applied,
  };
}

/**
 * The rail still says pending after the delivery: on crypto-native, part of the amount has arrived and the rest has not
 * (J-merchant-04 step 5), or a transfer is not yet final. Nothing is booked, and no dedupe marker is written, so the
 * next delivery (the rest, or this transfer seen deeper) still acts.
 */
function stillPending(adapter: RailAdapter, event: RailEvent, paymentId: string): WebhookOutcome {
  return { railId: adapter.id, eventId: event.eventId, type: event.type, duplicate: false, paymentId, applied: false };
}

export async function markFailed(svc: PayServiceInternal, paymentId: string, failureCode: string): Promise<void> {
  const view = await transaction(
    svc.sql,
    async (tx) => {
      const row = await lockPayment(tx, paymentId);
      if (row.status !== 'created' && row.status !== 'authorized') return null;
      await appendEvent(tx, row.id, 'failed', { failureCode });
      await tx`UPDATE pay.payments SET status = 'failed', updated_at = now() WHERE id = ${row.id}`;
      return svc.view(tx, { ...row, status: 'failed' });
    },
    { isolation: 'read committed', maxAttempts: 5 },
  );
  if (view) svc.notifyPaymentEvent('payment.failed', view);
}

/**
 * D26-P1-P5 — make `captured|settled → disputed` reachable so settlement
 * cannot freeze a payment whose clearing already left via the opening recipe.
 *
 * Status only. Money moves in `openChargeback` / is named-refused there.
 */
export async function markDisputed(
  svc: PayServiceInternal,
  paymentId: string,
  meta: {
    disputeId: string;
    reasonCode?: string | null;
    ledgerWire?: 'posted' | 'refused';
    ledgerTxId?: string | null;
  },
): Promise<PaymentView> {
  const ledgerWire = meta.ledgerWire ?? 'refused';
  return transaction(
    svc.sql,
    async (tx) => {
      const row = await lockPayment(tx, paymentId);
      // A redelivery already marked this payment. Status stays disputed so
      // the chargeback post can still run; a second event would not move money.
      if (row.status === 'disputed') return svc.view(tx, row);
      assertTransition(row, 'disputed');
      await appendEvent(tx, row.id, 'disputed', {
        disputeId: meta.disputeId,
        reasonCode: meta.reasonCode ?? null,
        ledgerWire,
        ledgerTxId: meta.ledgerTxId ?? null,
        ledgerSocket: ledgerWire === 'posted' ? null : 'socket.pay-chargeback-ledger-wire',
      });
      await tx`UPDATE pay.payments SET status = 'disputed', updated_at = now() WHERE id = ${row.id}`;
      return svc.view(tx, { ...row, status: 'disputed' });
    },
    { isolation: 'read committed', maxAttempts: 5 },
  );
}

/** `markDisputed` only when the payment is live right now (captured or settled). True when this call moved it. */
export async function markDisputedIfLive(
  svc: PayServiceInternal,
  paymentId: string,
  meta: Parameters<PayService['markDisputed']>[1],
): Promise<boolean> {
  const [row] = await svc.sql<Array<{ status: PaymentStatus }>>`SELECT status FROM pay.payments WHERE id = ${paymentId}`;
  if (!row || (row.status !== 'captured' && row.status !== 'settled')) return false;
  try {
    await svc.markDisputed(paymentId, meta);
    return true;
  } catch (err) {
    if (err instanceof PayError && err.code === 'pay.invalid_transition') return false;
    throw err;
  }
}

/**
 * A won dispute handed the money back (`reverseChargeback`), so a payment that
 * `markDisputed` froze must not stay terminal: it returns to `settled` when a
 * window already paid it, else to `captured` so a window can take it.
 *
 * Only when every case on the payment is won. An open case still has its
 * opening debit on the book; a lost or accepted one kept the money away.
 */
export async function restoreAfterWonDispute(svc: PayServiceInternal, paymentId: string, disputeId: string): Promise<void> {
  // Read the cases before the transaction: the caller already holds a pooled connection for the dispute lock, and
  // a read on the pool from inside a transaction would need a third one.
  const allWon = async () => {
    const cases = await svc.disputeCases.listForPayment(paymentId);
    return cases.length > 0 && cases.every((c) => c.status === 'won');
  };
  if (!(await allWon())) return;
  const restored = await transaction(
    svc.sql,
    async (tx) => {
      const row = await lockPayment(tx, paymentId);
      if (row.status !== 'disputed') return false;
      const settled = await tx<Array<{ ok: number }>>`
        SELECT 1 AS ok FROM pay.payment_events WHERE payment_id = ${paymentId} AND event = 'settled' LIMIT 1
      `;
      const next: PaymentStatus = settled.length > 0 ? 'settled' : 'captured';
      assertTransition(row, next);
      await appendEvent(tx, row.id, 'dispute.restored', { disputeId, status: next });
      await tx`UPDATE pay.payments SET status = ${next}, updated_at = now() WHERE id = ${row.id}`;
      return true;
    },
    { isolation: 'read committed', maxAttempts: 5 },
  );
  // A dispute opened while this ran saw the payment still disputed and did not mark it again. Mark it now.
  if (restored && !(await allWon())) await svc.markDisputed(paymentId, { disputeId });
}
