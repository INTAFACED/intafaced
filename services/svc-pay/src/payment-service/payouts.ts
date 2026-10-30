/**
 * Settlement payouts and settlement reads: pay out, reconcile a dispatched payout, list and read settlements.
 *
 * Moved out of `payment-service.ts` as it was (owner decision 2026-10-23): `PayService` keeps one method per
 * function here, which passes itself as `svc`.
 */
import { clearingPendingMessage, heldInSettlementOf } from './funds.js';
import { postPayLedger } from '../ledger-receipt.js';
import { FRESH, settleGuardRefusal } from '../seams/guards.js';
import type { Sql } from 'postgres';
import { formatAmount, merchantProceeds, parseAmount, recipes } from '@intafaced/ledger-client';
import { assertRailMayMoveValue } from '../rails/posture.js';
import { assertPayoutDestinationKind, DestinationKindError } from '../payout-destination.js';
import { PayoutDestinationMissingError } from '../merchant-payout-destination.js';
import { settlementLedgerPlan } from '../settlement-ledger.js';
import { dispatchedMarker, payoutRailKey, readDispatchedKey } from '../payout-dispatch.js';
import { encodeListCursor } from '../list-page.js';
import { safeFailure } from '../merchant-failure.js';
import { assertPayoutReserveWired } from '../control/reserve.js';
import { readPricingSnapshots } from '../control/snapshots.js';
import {
  finalizePayoutIdentity,
  PayoutAdmissionError,
  insertPayoutAdmission,
  loadPayoutAdmission,
  payoutTransaction,
  withPayoutLock,
} from '../payout-admission.js';
import { withMoneySpan, withRailSpan } from '../tracing.js';
import type {
  PayService,
  PayServiceInternal,
  SettlementDetailRow,
  SettlementLinePage,
  SettlementPage,
  SettlementRead,
  SettlementRecord,
  SettlementRow,
  SettlementStatus,
} from '../payment-service.js';
import {
  PayError,
  assertSettlementListLimit,
  legacyUserPayoutPlan,
  listFilters,
  payoutHoldKeys,
  readIncludedAmount,
  refuseUnusableRail,
  toSettlement,
} from './internal.js';

/**
 * Pay a settled window out of the book, to a bank or a chain (§6.1 "payout to
 * bank/crypto via adapter `payout`").
 *
 * Holds, settles, and reverses `merchantProceeds`. A personal withdrawal is
 * not this exit. There is no state in which the merchant's money is neither
 * in proceeds, nor in the proceeds payout hold, nor gone with a rail
 * reference against it. An attempt already held on the owner's user account
 * finishes on that hold so a second proceeds hold is not posted.
 *
 * IF THIS CRASHES between the hold and the dispatch marker, the funds are
 * in the proceeds payout hold and no rail call was journalled. Re-running
 * is an undispatched resume: a first refusal may still reverse.
 * The marker commits after the hold and before the rail, and it stores the
 * provider idempotency key. A resume that already has that marker treats
 * any refusal or error as unknown: the hold stays, `payout_attempts` stays,
 * and only `reconcileDispatchedPayout` may reverse or finalise, after it
 * queries that same key.
 */
export async function payoutSettlement(
  svc: PayServiceInternal,
  input: {
    settlementId: string;
    railId: string;
    destination?: { kind: string; ref: string };
    identityAuthority?: import('@intafaced/contracts').IdentityOperationIntent['authority'];
    /** A sandbox key cannot enter a live payout. */
    keyEnv?: 'sandbox';
  },
): Promise<SettlementRecord> {
  if (input.destination !== undefined) {
    throw new PayError('A payout cannot name a destination', 'pay.payout_destination_not_allowed');
  }
  return withMoneySpan('pay.payoutSettlement', { operation: 'payout', settlementId: input.settlementId, rail: input.railId }, async () => {
    return withPayoutLock(svc.sql, input.settlementId, async (connection) => {
      let settlement = await svc.getSettlement(input.settlementId, connection);
      let admission = await loadPayoutAdmission(connection, settlement.id, settlement.payoutAttempts);
      if (admission) {
        if (
          admission.rail_id !== input.railId ||
          parseAmount(admission.net) !== settlement.net ||
          admission.asset_id !== settlement.assetId ||
          admission.window !== settlement.window ||
          admission.merchant_id !== settlement.merchantId
        ) {
          throw new PayError('Recovery parameters differ from the admitted payout', 'pay.payout_recovery_conflict');
        }
      }
      // An admission that already existed when this call began is a resumed
      // payout; one this call creates cannot have a hold on the ledger yet.
      const resumedAdmission = admission !== null;
      if (settlement.status === 'paid_out') return settlement;
      if (settlement.status === 'pending') {
        // RC-merchant-10: a window waiting on the rail holds clearing, not available money. Refused by name, before any
        // admission, hold or rail call, so nothing moves.
        const held = await heldInSettlementOf(connection, settlement.id);
        if (held.length > 0)
          throw new PayError(clearingPendingMessage(settlement.id, held), 'pay.payout_clearing_pending', {
            settlementId: settlement.id,
            clearing: held.map((h) => h.amount),
          });
      }
      if (settlement.status !== 'posted' && settlement.status !== 'failed')
        throw new PayError('Settlement is not payable', 'pay.invalid_transition');
      if (settlement.status === 'failed') {
        // A window released before it posted has no proceeds behind it; only a failed payout may retry.
        const [released] = await connection`
            SELECT 1 FROM pay.settlements WHERE id = ${settlement.id} AND failure_code = 'pay.settlement_released'
          `;
        if (released) throw new PayError('Settlement was released before it posted; nothing to pay out', 'pay.settlement_released');
      }
      if (input.keyEnv === 'sandbox' || (await svc.settlementIncludesSandbox(connection, settlement.id))) {
        // Before the admission and before the hold. Both payout books name a live account.
        svc.refuseSandboxLive(
          true,
          recipes.merchantProceedsPayoutSettle({
            merchantId: settlement.merchantId,
            assetId: settlement.assetId,
            amount: settlement.net,
            rail: input.railId,
            withdrawalId: `${settlement.id}:${settlement.payoutAttempts}`,
          }),
        );
      }
      const adapter = svc.rails.require(admission?.rail_id ?? input.railId, 'payout');
      assertRailMayMoveValue(adapter, 'payout', svc.valueMovement);
      refuseUnusableRail(adapter, svc.now());
      // Classified before the admission exists. An unrecognised book must
      // refuse without a pending exposure row. A resumed admission already
      // has that row; its book is read below, once, for the plan.
      let payoutBook: 'legacy' | 'proceeds' | undefined;
      if (!admission) {
        // A resumed admission finishes under the net it was admitted with.
        // A fresh payout for a reserved merchant is refused before any admission:
        // a percentage already on the merchant (tier, or an override written before
        // set_reserve refused) must not leave as the full net. No recipe can hold
        // the reserved part, so nothing is admitted and no hold is posted.
        await assertPayoutReserveWired(connection, settlement.merchantId);
        const held = payoutHoldKeys(settlement.id, settlement.payoutAttempts);
        if ((await svc.ledger.getTxByKey(held.legacy)) || (await svc.ledger.getTxByKey(held.proceeds)))
          throw new PayError('Original payout owner record is missing', 'pay.payout_admission_missing');
        const merchant = await svc.getMerchant(settlement.merchantId, connection);
        payoutBook = await svc.recognisedPayoutBook({
          settlementId: settlement.id,
          merchantId: merchant.id,
          merchantUserId: merchant.userId,
          window: settlement.window,
          assetId: settlement.assetId,
        });
        if (payoutBook === 'proceeds') {
          // Refunds drawn on the proceeds after the settlement posted leave the frozen net larger than
          // the balance behind it. The merchant is owed the net less those refunds, so a fresh payout
          // is cut down to the balance before any admission exists: an admitted payout is immutable,
          // and its hold could never post. Gross falls with net; the fee is not returned on a refund.
          const available = (await svc.ledger.balance(merchantProceeds(merchant.id, settlement.assetId))).amount;
          if (available < settlement.net) {
            // A refund or a chargeback that may still be reversed (a refund the rail refuses, a won
            // dispute) would put its money back after the cut and strand it.
            const inFlight = await connection`
                SELECT 1
                  FROM pay.payments p
                  JOIN pay.payment_events r ON r.payment_id = p.id AND r.event = 'refund.posted'
                 WHERE p.merchant_id = ${settlement.merchantId}::uuid
                   AND p.currency = ${settlement.assetId}
                   AND NOT EXISTS (
                     SELECT 1 FROM pay.payment_events d
                      WHERE d.payment_id = p.id AND d.event IN ('refunded', 'refund.reversed')
                        AND d.payload->>'refundId' = r.payload->>'refundId'
                   )
                 LIMIT 1
              `;
            if (inFlight[0] || (await svc.hasUnresolvedDispute(connection, settlement.merchantId, settlement.assetId))) {
              throw new PayError(
                `Settlement ${settlement.id} cannot be paid out while a refund or dispute for this merchant is unresolved`,
                'pay.refund_in_flight',
                { settlementId: settlement.id },
              );
            }
            if (available <= 0n) {
              throw new PayError(
                `Settlement ${settlement.id} has nothing left to pay out (refunds drew on its proceeds)`,
                'pay.settlement_exceeds_proceeds',
                { settlementId: settlement.id },
              );
            }
            await connection`
                UPDATE pay.settlements
                   SET net = ${formatAmount(available)}::numeric,
                       gross = fees + ${formatAmount(available)}::numeric,
                       updated_at = now()
                 WHERE id = ${settlement.id}::uuid AND status IN ('posted', 'failed')
                   AND payout_attempts = ${settlement.payoutAttempts}
              `;
            settlement = await svc.getSettlement(settlement.id, connection);
          }
        }
        const destination = await svc.resolvePayoutDestination(adapter.id, merchant.id, connection);
        admission = await insertPayoutAdmission(
          connection,
          {
            settlement_id: settlement.id,
            merchant_id: merchant.id,
            merchant_user_id: merchant.userId,
            attempt: settlement.payoutAttempts,
            business_id: settlement.payoutAttempts === 0 ? settlement.id : `${settlement.id}:${settlement.payoutAttempts}`,
            net: formatAmount(settlement.net),
            asset_id: settlement.assetId,
            rail_id: adapter.id,
            destination_kind: destination.kind,
            destination_ref: destination.ref,
            window: settlement.window,
          },
          async (tx) => {
            svc.assertMerchantActive(await svc.lockMerchantEligibility(tx, merchant.id));
            const held = payoutHoldKeys(settlement.id, settlement.payoutAttempts);
            if ((await svc.ledger.getTxByKey(held.legacy)) || (await svc.ledger.getTxByKey(held.proceeds)))
              throw new PayError(
                'Unrecorded payout requires attributed recovery; hold alone cannot establish original destination',
                'pay.payout_admission_missing',
              );
            const locked = await tx`SELECT status,payout_attempts FROM pay.settlements WHERE id=${settlement.id} FOR UPDATE`;
            if (
              !locked[0] ||
              !['posted', 'failed'].includes(String(locked[0].status)) ||
              Number(locked[0].payout_attempts) !== settlement.payoutAttempts
            )
              throw new PayError('Settlement changed before admission', 'pay.payout_recovery_conflict');
            await svc.guards.beforePayoutAdmit({
              tx,
              settlementId: settlement.id,
              merchantId: merchant.id,
              assetId: settlement.assetId,
              amount: settlement.net,
              railId: adapter.id,
              destination: { kind: destination.kind, ref: destination.ref },
              attempt: settlement.payoutAttempts,
              replay: FRESH,
            });
          },
          svc.identityOperationAdmission,
          input.identityAuthority,
          svc.identityAuthorityGuard,
        );
        await svc.afterPayoutAdmission?.();
      }
      try {
        await finalizePayoutIdentity(
          connection,
          admission,
          async (tx) => svc.assertMerchantActive(await svc.lockMerchantEligibility(tx, admission!.merchant_id)),
          svc.identityOperationAdmission,
          svc.identityAuthorityGuard,
        );
      } catch (error) {
        if (error instanceof PayoutAdmissionError) throw new PayError(error.message, error.code);
        throw error;
      }
      const proceedsPlan = settlementLedgerPlan({
        settlementId: admission.settlement_id,
        payoutAttempt: admission.attempt,
        merchantId: admission.merchant_id,
        assetId: admission.asset_id,
        amount: parseAmount(admission.net),
        railId: admission.rail_id,
        destinationKind: admission.destination_kind,
      });
      // The settlement's own post decides the pot. A pre-cutover window
      // debited userAvailable, so its payout is the personal withdraw trio.
      // A proceeds window never pays from that hold. Fresh calls already
      // classified above; a resumed admission classifies here, still before
      // any new hold.
      const book =
        payoutBook ??
        (await svc.recognisedPayoutBook({
          settlementId: admission.settlement_id,
          merchantId: admission.merchant_id,
          merchantUserId: admission.merchant_user_id,
          window: admission.window,
          assetId: admission.asset_id,
        }));
      const plan =
        book === 'legacy'
          ? legacyUserPayoutPlan(
              admission.merchant_user_id,
              admission.asset_id,
              parseAmount(admission.net),
              admission.rail_id,
              proceedsPlan.withdrawalId,
              proceedsPlan.destinationKind,
            )
          : proceedsPlan;
      const outcomes = await connection`SELECT kind,payload FROM pay.payout_outcomes WHERE admission_id=${admission.id}`;
      let accepted = outcomes.find((outcome) => outcome.kind === 'rail_accepted')?.payload as { railRef: string } | undefined;
      let refused = outcomes.find((outcome) => outcome.kind === 'rail_refused')?.payload as
        { failureReason: string; failureCode: string } | undefined;
      const dispatched = outcomes.find((outcome) => outcome.kind === 'dispatched');
      // Read before this call inserts its own marker. A row already there
      // is an earlier dispatch, same rule as a user withdrawal's firstDispatch.
      const priorDispatched = dispatched !== undefined;
      // Only a rail call made on this attempt feeds auto-trip. A stored
      // outcome is bookkeeping for a call that already counted, or didn't.
      let freshRail: 'accepted' | 'refused' | null = null;
      if (!refused && !accepted) {
        const instruction = {
          settlementId: admission.business_id,
          merchantId: admission.merchant_id,
          amount: parseAmount(admission.net),
          assetId: admission.asset_id,
          window: admission.window,
          destination: { kind: admission.destination_kind, ref: admission.destination_ref },
        };
        const idempotencyKey = payoutRailKey(adapter, instruction);
        if (!idempotencyKey) {
          throw new PayError('Payout rail does not name an idempotency key; refusing before the hold', 'pay.rail_outcome_unknown', {
            settlementId: admission.settlement_id,
          });
        }
        const storedKey = readDispatchedKey(dispatched?.payload);
        if (priorDispatched && storedKey !== idempotencyKey) {
          throw new PayError('Dispatched payout key does not match the rail key; hold kept', 'pay.rail_outcome_unknown', {
            settlementId: admission.settlement_id,
            idempotencyKey: storedKey,
            state: 'dispatched',
          });
        }
        // Seam: before any hold is posted or rail asked, including crash
        // recovery. Recovery means the hold is already on the ledger (value in
        // flight); an admitted payout that has moved nothing yet is `fresh`,
        // so a halt still stops it.
        const holdBooked = resumedAdmission && (await svc.ledger.getTxByKey(plan.hold.idempotencyKey)) !== null;
        await svc.guards.beforePayoutExecute({
          sql: connection,
          settlementId: admission.settlement_id,
          merchantId: admission.merchant_id,
          assetId: admission.asset_id,
          amount: parseAmount(admission.net),
          railId: admission.rail_id,
          destination: { kind: admission.destination_kind, ref: admission.destination_ref },
          attempt: admission.attempt,
          replay: holdBooked ? { kind: 'recovery', reason: 'payout_hold_booked' } : FRESH,
        });
        await postPayLedger(svc.ledger, plan.hold);
        // The ledger hold is already durable. This transaction commits the
        // marker, including that hold's key, before the rail is asked.
        if (!priorDispatched) {
          await payoutTransaction(connection, async (tx) => {
            await tx`INSERT INTO pay.payout_outcomes(admission_id,kind,payload) VALUES(${admission!.id},'dispatched',${tx.json(dispatchedMarker(idempotencyKey, plan.hold.idempotencyKey))}) ON CONFLICT DO NOTHING`;
          });
        }
        const unknownDispatch = (message: string) =>
          new PayError(message, 'pay.rail_outcome_unknown', {
            settlementId: admission!.settlement_id,
            idempotencyKey,
            state: 'dispatched',
          });
        let result: Awaited<ReturnType<typeof adapter.payout>>;
        try {
          result = await withRailSpan(adapter.id, 'payout', () => adapter.payout(instruction));
        } catch (error) {
          // The hold is already on the ledger. Counting may halt the next
          // payout. It does not reverse this one or replace the throw.
          await svc.accountRailOutcome({
            kind: 'throw',
            target: { level: 'merchant', merchantId: admission.merchant_id },
            railId: admission.rail_id,
            connection,
          });
          if (priorDispatched) throw unknownDispatch('Earlier payout dispatch is unknown; original hold remains');
          throw error;
        }
        if (!result.ok) {
          if (priorDispatched) {
            await svc.accountRailOutcome({
              kind: 'throw',
              target: { level: 'merchant', merchantId: admission.merchant_id },
              railId: admission.rail_id,
              connection,
            });
            throw unknownDispatch('Earlier payout dispatch is unknown; a later refusal is not proof the rail did not send');
          }
          freshRail = 'refused';
          refused = { failureReason: result.failureReason ?? 'Rail refused', failureCode: result.failureCode ?? 'rail.failed' };
          await connection`INSERT INTO pay.payout_outcomes(admission_id,kind,payload) VALUES(${admission.id},'rail_refused',${connection.json(refused)})`;
        } else {
          if (result.amount !== parseAmount(admission.net) || result.assetId !== admission.asset_id) {
            if (priorDispatched) throw unknownDispatch('Earlier payout dispatch is unknown; rail answer does not match the hold');
            throw new PayError('Payout rail amount or asset differs', 'pay.rail_amount_mismatch');
          }
          freshRail = 'accepted';
          accepted = { railRef: result.railRef };
          await connection`INSERT INTO pay.payout_outcomes(admission_id,kind,payload) VALUES(${admission.id},'rail_accepted',${connection.json(accepted)})`;
        }
      }
      if (!accepted) {
        await postPayLedger(svc.ledger, plan.reverse);
        await payoutTransaction(connection, async (tx) => {
          await tx`INSERT INTO pay.payout_outcomes(admission_id,kind,payload) VALUES(${admission!.id},'reversed','{}') ON CONFLICT DO NOTHING`;
          await tx`UPDATE pay.settlements SET status='failed',payout_attempts=${admission!.attempt + 1},failed_at=now(),failure_code=${(safeFailure(refused?.failureCode ?? 'rail.failed') ?? { code: 'pay.failed' }).code},updated_at=now() WHERE id=${settlement.id}`;
        });
        // After the refusal is durable. Accounting must not unwind the
        // reverse or replace pay.rail_failed: the book already shows the payout failed.
        if (freshRail === 'refused') {
          await svc.accountRailOutcome({
            kind: 'failure',
            target: { level: 'merchant', merchantId: admission.merchant_id },
            railId: admission.rail_id,
            failureCode: refused?.failureCode,
            eventKey: `payout:${admission.settlement_id}:${admission.attempt}`,
            connection,
          });
        }
        throw new PayError(refused?.failureReason ?? 'Rail refused payout', 'pay.rail_failed', { failureCode: refused?.failureCode });
      }
      await postPayLedger(svc.ledger, plan.settle);
      await payoutTransaction(connection, async (tx) => {
        await tx`INSERT INTO pay.payout_outcomes(admission_id,kind,payload) VALUES(${admission!.id},'settled','{}') ON CONFLICT DO NOTHING`;
        await tx`UPDATE pay.settlements SET status='paid_out',payout_method=${admission!.rail_id},payout_ref=${accepted!.railRef},sent_at=COALESCE(sent_at, now()),failed_at=NULL,failure_code=NULL,updated_at=now() WHERE id=${settlement.id}`;
      });
      if (freshRail === 'accepted') {
        await svc.accountRailOutcome({
          kind: 'success',
          target: { level: 'merchant', merchantId: admission.merchant_id },
          railId: admission.rail_id,
          connection,
        });
      }
      return { ...settlement, status: 'paid_out' as const, payoutMethod: admission.rail_id, payoutRef: accepted.railRef };
    });
  }).catch(async (error) => {
    // The payout lock, its reserved connection and the admission transaction are all gone here.
    await settleGuardRefusal(error);
    if (error instanceof PayoutAdmissionError) throw new PayError(error.message, error.code);
    throw error;
  });
}

/**
 * Ask the rail about a dispatched payout's original key, then reverse once
 * or finalise once. A rail with no status query leaves the hold where it is.
 */
export async function reconcileDispatchedPayout(svc: PayServiceInternal, settlementId: string): Promise<SettlementRecord> {
  return withMoneySpan('pay.reconcileDispatchedPayout', { operation: 'payout', settlementId }, async () => {
    return withPayoutLock(svc.sql, settlementId, async (connection) => {
      const settlement = await svc.getSettlement(settlementId, connection);
      if (settlement.status === 'paid_out') return settlement;
      const admission = await loadPayoutAdmission(connection, settlement.id, settlement.payoutAttempts);
      if (!admission) {
        if (settlement.status === 'failed') return settlement;
        throw new PayError('Payout has no admission to reconcile', 'pay.invalid_transition');
      }
      const outcomes = await connection`SELECT kind,payload FROM pay.payout_outcomes WHERE admission_id=${admission.id}`;
      const accepted = outcomes.find((outcome) => outcome.kind === 'rail_accepted')?.payload as { railRef: string } | undefined;
      const reversed = outcomes.some((outcome) => outcome.kind === 'reversed');
      const settled = outcomes.some((outcome) => outcome.kind === 'settled');
      if (reversed || settlement.status === 'failed') return svc.getSettlement(settlementId, connection);
      const proceedsPlan = settlementLedgerPlan({
        settlementId: admission.settlement_id,
        payoutAttempt: admission.attempt,
        merchantId: admission.merchant_id,
        assetId: admission.asset_id,
        amount: parseAmount(admission.net),
        railId: admission.rail_id,
        destinationKind: admission.destination_kind,
      });
      const book = await svc.recognisedPayoutBook({
        settlementId: admission.settlement_id,
        merchantId: admission.merchant_id,
        merchantUserId: admission.merchant_user_id,
        window: admission.window,
        assetId: admission.asset_id,
      });
      const plan =
        book === 'legacy'
          ? legacyUserPayoutPlan(
              admission.merchant_user_id,
              admission.asset_id,
              parseAmount(admission.net),
              admission.rail_id,
              proceedsPlan.withdrawalId,
              proceedsPlan.destinationKind,
            )
          : proceedsPlan;
      let railRef = accepted?.railRef;
      if (!railRef) {
        const dispatched = outcomes.find((outcome) => outcome.kind === 'dispatched');
        const idempotencyKey = readDispatchedKey(dispatched?.payload);
        if (!dispatched || !idempotencyKey) {
          throw new PayError('Payout was not dispatched; there is no original key to query', 'pay.invalid_transition');
        }
        const adapter = svc.rails.require(admission.rail_id, 'payout');
        if (typeof adapter.queryPayout !== 'function') {
          throw new PayError('Payout rail has no status query; dispatched hold stays', 'pay.rail_outcome_unknown', {
            settlementId,
            idempotencyKey,
            state: 'dispatched',
          });
        }
        let queried: Awaited<ReturnType<NonNullable<typeof adapter.queryPayout>>>;
        try {
          queried = await adapter.queryPayout(idempotencyKey);
        } catch {
          throw new PayError('Payout rail status query failed; dispatched hold stays', 'pay.rail_outcome_unknown', {
            settlementId,
            idempotencyKey,
            state: 'dispatched',
          });
        }
        if (queried.status === 'unknown') {
          throw new PayError('Payout rail cannot say whether the original key was sent; hold stays', 'pay.rail_outcome_unknown', {
            settlementId,
            idempotencyKey,
            state: 'dispatched',
          });
        }
        if (queried.status === 'not_sent') {
          const failureCode = 'rail.not_sent';
          const failureReason = 'Rail status query confirmed the original key was not sent';
          await postPayLedger(svc.ledger, plan.reverse);
          await payoutTransaction(connection, async (tx) => {
            await tx`INSERT INTO pay.payout_outcomes(admission_id,kind,payload) VALUES(${admission.id},'rail_refused',${tx.json({ failureReason, failureCode })}) ON CONFLICT DO NOTHING`;
            await tx`INSERT INTO pay.payout_outcomes(admission_id,kind,payload) VALUES(${admission.id},'reversed','{}') ON CONFLICT DO NOTHING`;
            await tx`UPDATE pay.settlements SET status='failed',payout_attempts=${admission.attempt + 1},failed_at=now(),failure_code=${(safeFailure(failureCode) ?? { code: 'pay.failed' }).code},updated_at=now() WHERE id=${settlement.id}`;
          });
          await svc.accountRailOutcome({
            kind: 'failure',
            target: { level: 'merchant', merchantId: admission.merchant_id },
            railId: admission.rail_id,
            failureCode,
            eventKey: `payout:${admission.settlement_id}:${admission.attempt}`,
            connection,
          });
          return svc.getSettlement(settlementId, connection);
        }
        if (
          (queried.amount !== null && queried.amount !== parseAmount(admission.net)) ||
          (queried.assetId !== null && queried.assetId !== admission.asset_id) ||
          !queried.railRef.trim()
        ) {
          throw new PayError('Payout rail status does not match the held payout', 'pay.rail_amount_mismatch', {
            settlementId,
            idempotencyKey,
            state: 'dispatched',
          });
        }
        railRef = queried.railRef;
        await connection`INSERT INTO pay.payout_outcomes(admission_id,kind,payload) VALUES(${admission.id},'rail_accepted',${connection.json({ railRef })})`;
      }
      if (settled) return svc.getSettlement(settlementId, connection);
      await postPayLedger(svc.ledger, plan.settle);
      await payoutTransaction(connection, async (tx) => {
        await tx`INSERT INTO pay.payout_outcomes(admission_id,kind,payload) VALUES(${admission.id},'settled','{}') ON CONFLICT DO NOTHING`;
        await tx`UPDATE pay.settlements SET status='paid_out',payout_method=${admission.rail_id},payout_ref=${railRef!},sent_at=COALESCE(sent_at, now()),failed_at=NULL,failure_code=NULL,updated_at=now() WHERE id=${settlement.id}`;
      });
      await svc.accountRailOutcome({
        kind: 'success',
        target: { level: 'merchant', merchantId: admission.merchant_id },
        railId: admission.rail_id,
        connection,
      });
      return {
        ...(await svc.getSettlement(settlementId, connection)),
        status: 'paid_out' as const,
        payoutMethod: admission.rail_id,
        payoutRef: railRef,
      };
    });
  });
}

/**
 * The stored verified destination for this rail. An offered destination is
 * refused before this runs. Unverified rows (saved by payouts before D-142)
 * are not payable. Does not write. Does not invent a PSP.
 */
export async function resolvePayoutDestination(
  svc: PayServiceInternal,
  railId: string,
  merchantId: string,
  connection?: Sql,
): Promise<{ kind: string; ref: string }> {
  try {
    const stored = await svc.payoutDestinations.require({ merchantId, railId, connection });
    assertPayoutDestinationKind(railId, stored);
    return stored;
  } catch (err) {
    if (err instanceof PayoutDestinationMissingError) {
      throw new PayError(err.message, 'pay.payout_destination_missing', { merchantId, railId });
    }
    if (err instanceof DestinationKindError) {
      throw new PayError(err.message, err.code);
    }
    throw err;
  }
}

export async function getSettlement(svc: PayServiceInternal, settlementId: string, connection: Sql = svc.sql): Promise<SettlementRecord> {
  const rows = await connection<SettlementRow[]>`
    SELECT id, merchant_id, "window", asset_id, gross, fees, net, payout_method, payout_ref, payout_attempts, status
      FROM pay.settlements WHERE id = ${settlementId}
  `;
  const row = rows[0];
  if (!row) throw new PayError(`Settlement ${settlementId} not found`, 'pay.settlement_not_found');
  return toSettlement(row);
}

/**
 * Merchant fleet list — settlements already stored; this only reads them.
 * No freeze, no post, no payout. Caller fences merchant ownership / area.
 */
export async function listSettlements(
  svc: PayServiceInternal,
  input: {
    merchantId: string;
    status?: SettlementStatus;
    limit?: number;
    cursor?: string;
    search?: string;
    assetId?: string;
    from?: string;
    to?: string;
  },
): Promise<SettlementPage> {
  await svc.getMerchant(input.merchantId);
  const limit = assertSettlementListLimit(input.limit);
  const filters = listFilters(input);
  svc.assertListStatus(input.status, ['pending', 'posted', 'paid_out', 'failed']);
  const cursorAt = filters.cursor?.createdAtCursor ?? null;
  const cursorId = filters.cursor?.id ?? null;
  const rows = await svc.sql<Array<SettlementDetailRow>>`
    SELECT id, merchant_id, "window", asset_id, gross, fees, net,
           payout_method, payout_ref, payout_attempts, status,
           created_at, sent_at, settled_at, failed_at, failure_code,
           to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor
      FROM pay.settlements
     WHERE merchant_id = ${input.merchantId}
       AND (${input.status ?? null}::text IS NULL OR status::text = ${input.status ?? null})
       AND (${filters.assetId}::text IS NULL OR asset_id = ${filters.assetId})
       AND (${filters.from}::timestamptz IS NULL OR created_at >= ${filters.from})
       AND (${filters.to}::timestamptz IS NULL OR created_at < ${filters.to})
       AND (
         ${filters.search}::text IS NULL
         OR id::text = lower(${filters.search})
         OR "window" = ${filters.search}
         OR payout_ref = ${filters.search}
       )
       AND (
         ${cursorAt}::timestamptz IS NULL
         OR (created_at, id) < (${cursorAt}::timestamptz, ${cursorId}::uuid)
       )
     ORDER BY created_at DESC, id DESC
     LIMIT ${limit + 1}
  `;
  return svc.settlementPage(rows, limit);
}

/** One settlement with the timestamps, failure and pricing snapshot stored for it. */
export async function readSettlement(svc: PayServiceInternal, settlementId: string): Promise<SettlementRead> {
  const rows = await svc.sql<SettlementDetailRow[]>`
    SELECT id, merchant_id, "window", asset_id, gross, fees, net,
           payout_method, payout_ref, payout_attempts, status,
           created_at, sent_at, settled_at, failed_at, failure_code,
           to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor
      FROM pay.settlements WHERE id = ${settlementId}
  `;
  const row = rows[0];
  if (!row) throw new PayError(`Settlement ${settlementId} not found`, 'pay.settlement_not_found');
  const page = await svc.settlementPage([row], 1);
  return page.items[0]!;
}

/**
 * Payments frozen into this settlement, oldest first, paged by `(created_at, id)`.
 * The amount is the net written on `settlement.included` at freeze. A payment's
 * face amount does not sum to the gross once a capture or refund was partial.
 * An included event from before that field returns a null amount and a flag.
 */
export async function listSettlementLines(
  svc: PayServiceInternal,
  input: { settlementId: string; limit?: number; cursor?: string },
): Promise<SettlementLinePage> {
  const limit = assertSettlementListLimit(input.limit);
  const filters = listFilters({ cursor: input.cursor });
  const cursorAt = filters.cursor?.createdAtCursor ?? null;
  const cursorId = filters.cursor?.id ?? null;
  const rows = await svc.sql<
    Array<{ id: string; included_amount: string | null; currency: string; created_at: Date; created_at_cursor: string }>
  >`
    SELECT id, included_amount, currency, created_at, created_at_cursor FROM (
      SELECT DISTINCT ON (p.id) p.id, e.payload->>'amount' AS included_amount, p.currency, p.created_at,
             to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor
        FROM pay.payment_events e
        JOIN pay.payments p ON p.id = e.payment_id
        JOIN pay.settlements s ON s.id = ${input.settlementId}::uuid
       WHERE e.event = 'settlement.included'
         AND e.payload->>'settlementId' = s.id::text
         AND p.merchant_id = s.merchant_id
       ORDER BY p.id, e.seq
    ) lines
     WHERE (
       ${cursorAt}::timestamptz IS NULL
       OR (created_at, id) > (${cursorAt}::timestamptz, ${cursorId}::uuid)
     )
     ORDER BY created_at ASC, id ASC
     LIMIT ${limit + 1}
  `;
  const pageRows = rows.slice(0, limit);
  const last = pageRows[pageRows.length - 1];
  return {
    items: pageRows.map((row) => {
      const included = readIncludedAmount(row.included_amount);
      return {
        paymentId: row.id,
        amount: included.amount,
        assetId: row.currency,
        createdAt: row.created_at,
        includedAmountKnown: included.includedAmountKnown,
      };
    }),
    nextCursor: rows.length > limit && last ? encodeListCursor(last.created_at_cursor, last.id) : null,
  };
}

export async function settlementPage(svc: PayServiceInternal, rows: SettlementDetailRow[], limit: number): Promise<SettlementPage> {
  const pageRows = rows.slice(0, limit);
  const snapshots = await readPricingSnapshots(
    svc.sql,
    'settlement',
    pageRows.map((row) => row.id),
  );
  const items = pageRows.map((row) => {
    const failed = row.status === 'failed';
    return {
      ...toSettlement(row),
      createdAt: row.created_at,
      sentAt: row.sent_at,
      settledAt: row.settled_at,
      failedAt: failed ? row.failed_at : null,
      failure: failed ? safeFailure(row.failure_code) : null,
      pricingSnapshot: snapshots.get(row.id) ?? null,
    };
  });
  const last = pageRows[pageRows.length - 1];
  return {
    items,
    nextCursor: rows.length > limit && last ? encodeListCursor(last.created_at_cursor, last.id) : null,
  };
}
