/**
 * Settlement windows: post a pending settlement, prepare and release it, affiliate notices, rail outcomes.
 *
 * Moved out of `payment-service.ts` as it was (owner decision 2026-10-23): `PayService` keeps one method per
 * function here, which passes itself as `svc`.
 */
import { postPayLedger } from '../ledger-receipt.js';
import { FRESH, type GuardReplay } from '../seams/guards.js';
import { noteAutoTripAccountError } from '../halts/autotrip-log.js';
import { isRailHealthFailureCode } from '../halts/rail-health.js';
import { payoutRailSourceKey, targetKey } from '../halts/store.js';
import type { PayHaltTarget } from '../halts/types.js';
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { formatAmount, mulBps, parseAmount, recipes, type Amount } from '@intafaced/ledger-client';
import { classifySettlementTx, legacyPostMatchesFrozen } from '../settlement-book.js';
import { merchantKybMoneyGateRefusal } from '../merchant-kyb-money-gate.js';
import { withMoneySpan } from '../tracing.js';
import { affiliateLegAfterPaySettlement, fireAffiliateAccrue } from '../affiliate-accrue.js';
import { fireAffiliatePayout } from '../affiliate-payout.js';
import type {
  MerchantRecord,
  PayService,
  PayServiceInternal,
  SettlementRecord,
  SettlementRow,
  SettlementStatus,
} from '../payment-service.js';
import { fundsHeldOf, heldClearingOf } from './funds.js';
import { PayError, appendEvent, lockPayment, publishedDefaultFeeBps, toSettlement, totalsFor, windowBounds } from './internal.js';

// ── Settlement (§6.1) ──────────────────────────────────────────────────────

/**
 * Settle a window: merchant net posts to their ledger account — "the same
 * balance graph they trade and spend from — the doc's promise, kept".
 *
 * Two phases, because the alternative silently loses money:
 *
 *   1. Freeze. The payment set is fixed by appending `settlement.included` to
 *      each payment, and gross/fees/net are computed and stored `pending`.
 *   2. Post. The ledger transaction uses the FROZEN numbers.
 *
 * If it were one phase, a crash between posting and committing would leave a
 * ledger transaction keyed `settlement:<merchant>:<window>:<asset>` for one
 * gross while a retry — now including a payment that landed in the meantime —
 * computed a different gross, posted it, and got the ORIGINAL transaction
 * back from the idempotency check. The database would then record a
 * settlement the ledger never made. Freezing first makes the retry
 * arithmetically identical.
 *
 * MERCHANT STATUS. Only an `active` merchant freezes a new window or posts
 * one. `createPayment` and public checkout already refuse non-active; until
 * this gate, a suspended merchant could still settle captured volume and take
 * it out via `payoutSettlement` — suspension that stopped inbound only.
 * Re-reading an already-posted settlement is still fine (no value moves).
 */
export async function settleWindow(
  svc: PayServiceInternal,
  input: {
    merchantId: string;
    /** Window label, e.g. '2026-07-27'. Half the business key. */
    window: string;
    assetId: string;
    /** Defaults to the UTC day named by `window`. */
    from?: Date;
    to?: Date;
    /** A sandbox key cannot freeze or post a live settlement. */
    keyEnv?: 'sandbox';
  },
): Promise<SettlementRecord> {
  if (input.keyEnv === 'sandbox') {
    // The amounts name the recipe's accounts. They are not posted.
    svc.refuseSandboxLive(
      true,
      recipes.merchantSettlement({
        merchantId: input.merchantId,
        merchantUserId: input.merchantId,
        window: input.window,
        assetId: input.assetId,
        gross: 2n,
        fee: 1n,
      }),
    );
  }
  return withMoneySpan(
    'pay.settleWindow',
    { operation: 'settlement', merchantId: input.merchantId, window: input.window, assetId: input.assetId },
    async (span) => {
      // A window that already exists is a re-run: still `pending` means frozen
      // and not yet posted (a ledger post may have landed), anything else is a
      // pure repeat. A window that does not exist yet is fresh work.
      const [prior] = await svc.sql<Array<{ status: SettlementStatus }>>`
        SELECT status FROM pay.settlements
         WHERE merchant_id = ${input.merchantId} AND "window" = ${input.window} AND asset_id = ${input.assetId}
      `;
      const rerun: GuardReplay = !prior
        ? FRESH
        : prior.status === 'pending'
          ? { kind: 'recovery', reason: 'window_frozen_not_posted' }
          : { kind: 'replay', reason: 'window_already_frozen' };
      await svc.guards.beforeSettlementRun({
        sql: svc.sql,
        phase: 'prepare',
        merchantId: input.merchantId,
        assetId: input.assetId,
        window: input.window,
        replay: rerun,
      });
      const prepared = await svc.prepareSettlement(input);
      // RC-merchant-10: the run names what the rail still holds in this window. Those payments stay in clearing; this run
      // posts none of them.
      const bounds = windowBounds(input.window, input.from, input.to);
      const withHeld = async (record: SettlementRecord): Promise<SettlementRecord> => {
        const held = await heldClearingOf(svc.sql, record.merchantId, record.assetId, { settlementId: record.id, ...bounds });
        return held.length > 0 ? { ...record, clearingPending: held } : record;
      };
      if (prepared.status !== 'pending') return withHeld(prepared);
      try {
        return await withHeld(await svc.postPendingSettlement(prepared.id, prior ? rerun : FRESH, span));
      } catch (err) {
        // A payment in the frozen set was disputed after the freeze, so the post can never succeed. Free the
        // window now (heal first, no ledger value moves) so its other payments reach a later window without
        // an operator, then still refuse this run.
        if (err instanceof PayError && err.code === 'pay.settlement_desynced') {
          await svc.releasePendingSettlement({
            settlementId: prepared.id,
            reason: 'automatic: the frozen set no longer matches live captured minus refunded',
          });
        }
        throw err;
      }
    },
  );
}

/**
 * Phase 2 of settle — post ledger + project, keyed by settlement id.
 * Used by settleWindow and by release heal (which must not re-parse window
 * labels — custom windows need from/to that release does not have).
 */
export async function postPendingSettlement(
  svc: PayServiceInternal,
  settlementId: string,
  replay: GuardReplay,
  span?: { setAttribute: (k: string, v: string | number) => void },
): Promise<SettlementRecord> {
  const head = await svc.sql<SettlementRow[]>`
    SELECT id, merchant_id, "window", asset_id, gross, fees, net, payout_method, payout_ref, payout_attempts, status
      FROM pay.settlements WHERE id = ${settlementId}
  `;
  const current = head[0];
  if (!current) throw new PayError(`Settlement ${settlementId} not found`, 'pay.settlement_not_found');
  if (current.status !== 'pending') return toSettlement(current);
  await svc.guards.beforeSettlementRun({
    sql: svc.sql,
    phase: 'post',
    merchantId: current.merchant_id,
    assetId: current.asset_id,
    window: current.window,
    settlementId: current.id,
    replay,
  });

  // The unlocked merchant read is not the credit gate. Eligibility is locked
  // below, on this transaction, before the ledger post.
  let merchantUserId: string | undefined;
  const posted = await transaction(
    svc.sql,
    async (tx) => {
      const rows = await tx<SettlementRow[]>`
        SELECT id, merchant_id, "window", asset_id, gross, fees, net, payout_method, payout_ref, payout_attempts, status
          FROM pay.settlements WHERE id = ${settlementId} FOR UPDATE
      `;
      const row = rows[0]!;
      if (row.status !== 'pending') return toSettlement(row);

      // Merchant eligibility, then payment rows — the same order as capture.
      // A suspend that commits before this lock must not credit available
      // or mark the window posted. Frozen gross, fees, and net stay as frozen.
      await svc.beforeSettlementPostMerchantLock?.();
      const merchant = await svc.lockMerchantEligibility(tx, row.merchant_id);
      svc.assertMerchantActive(merchant);
      merchantUserId = merchant.userId;

      const gross = parseAmount(row.gross);
      const fees = parseAmount(row.fees);

      const included = await tx<Array<{ payment_id: string }>>`
        SELECT payment_id FROM pay.payment_events
         WHERE event = 'settlement.included' AND payload->>'settlementId' = ${row.id}
         ORDER BY payment_id
      `;

      const settlementPost = recipes.merchantSettlement({
        merchantId: row.merchant_id,
        merchantUserId: merchant.userId,
        window: row.window,
        assetId: row.asset_id,
        gross,
        fee: fees,
      });
      // A settlement the ledger already booked (the app transaction rolled back after the post) is adopted below, not
      // rechecked: a dispute opened since then must not turn an already-paid window into a refusal that release can re-pay.
      // Otherwise re-check live nets under payment row locks before the ledger moves. The freeze promised these numbers;
      // if a concurrent path (or an operator) changed captured/refunded, posting the frozen gross would take someone
      // else's clearing.
      const existing = await svc.ledger.getTxByKey(settlementPost.idempotencyKey);
      if (!existing) {
        let liveGross = 0n;
        // RC-merchant-10: a window frozen while the rail held its funds waits. Nothing posts until the rail's
        // `funds.available` is on every payment still in it; the re-run after that posts once, on the same key.
        let waitingOnRail = false;
        for (const { payment_id } of included) {
          const locked = await lockPayment(tx, payment_id);
          // A dispute opened after the freeze took this payment's clearing back through the opening post, so its
          // captured amount no longer sits in the pool. Counting it would post other payments' money to the merchant.
          if (locked.status === 'disputed') continue;
          const totals = await totalsFor(tx, payment_id);
          const net = totals.captured - totals.refunded;
          if (net <= 0n) continue;
          liveGross += net;
          if ((await fundsHeldOf(tx, payment_id)).held) waitingOnRail = true;
        }
        if (liveGross !== gross) {
          throw new PayError(
            `Settlement ${row.id} frozen gross ${formatAmount(gross)} no longer matches live captured−refunded ${formatAmount(liveGross)} — refusing to post`,
            'pay.settlement_desynced',
            {
              settlementId: row.id,
              frozenGross: formatAmount(gross),
              liveGross: formatAmount(liveGross),
            },
          );
        }
        // Checked after the desync, so a window whose frozen set changed (a held payment disputed since) is still
        // released automatically instead of waiting on a release that can never come.
        if (waitingOnRail) return toSettlement(row);
      }

      if (await svc.settlementIncludesSandbox(tx, row.id)) svc.refuseSandboxLive(true, settlementPost);
      const bookInput = {
        merchantId: row.merchant_id,
        merchantUserId: merchant.userId,
        assetId: row.asset_id,
      };
      // A window posted before proceeds existed already holds this key, debiting
      // userAvailable. Posting the proceeds body would conflict. Adopt that
      // transaction: the ledger post is the legacy mark, and this row becomes posted.
      if (!existing) {
        await postPayLedger(svc.ledger, settlementPost);
      } else {
        const book = await classifySettlementTx(svc.ledger, existing, bookInput);
        if (book === 'proceeds') {
          await postPayLedger(svc.ledger, settlementPost);
        } else if (book === 'legacy') {
          if (!(await legacyPostMatchesFrozen(svc.ledger, existing, { ...bookInput, gross, fee: fees }))) {
            throw new PayError(
              `Settlement ${row.id} already has a personal-balance post that does not match the frozen window`,
              'pay.settlement_ledger_conflict',
              { settlementId: row.id },
            );
          }
        } else {
          throw new PayError(`Settlement ${row.id} ledger post is not a recognised settlement`, 'pay.settlement_book_unrecognised', {
            settlementId: row.id,
          });
        }
      }

      await tx`
        UPDATE pay.settlements
           SET status = 'posted', payout_method = 'ledger', settled_at = COALESCE(settled_at, now()), updated_at = now()
         WHERE id = ${row.id}
      `;

      for (const { payment_id } of included) {
        await appendEvent(tx, payment_id, 'settled', {
          settlementId: row.id,
          window: row.window,
          assetId: row.asset_id,
        });
        await tx`
          UPDATE pay.payments SET status = 'settled', updated_at = now()
           WHERE id = ${payment_id} AND status = 'captured'
        `;
      }

      span?.setAttribute('intafaced.amount', formatAmount(parseAmount(row.net)));
      span?.setAttribute('intafaced.payments', included.length);
      return toSettlement({ ...row, status: 'posted', payout_method: 'ledger' });
    },
    { isolation: 'read committed', maxAttempts: 5 },
  );
  // Already posted by a concurrent winner: no credit happened here. Accrue
  // still wants the merchant user id, and that read is not a credit gate.
  const userId = merchantUserId ?? (await svc.getMerchant(posted.merchantId)).userId;
  await svc.notifyPayAffiliateAccrue(posted, userId);
  await svc.notifyPayAffiliatePayout(posted, userId);
  return posted;
}

/** Best-effort; never throws. Settlement already committed. */
export async function notifyPayAffiliateAccrue(svc: PayServiceInternal, posted: SettlementRecord, merchantUserId: string): Promise<void> {
  if (posted.status !== 'posted') return;
  await fireAffiliateAccrue(
    svc.affiliateAccrue,
    affiliateLegAfterPaySettlement({
      settlementId: posted.id,
      merchantUserId,
      feeAmount: posted.fees,
      feeAsset: posted.assetId,
    }),
  );
}

/** Best-effort payout after accrue; never throws. Settlement already committed. */
export async function notifyPayAffiliatePayout(svc: PayServiceInternal, posted: SettlementRecord, merchantUserId: string): Promise<void> {
  if (posted.status !== 'posted') return;
  await fireAffiliatePayout(
    svc.affiliatePayout,
    affiliateLegAfterPaySettlement({
      settlementId: posted.id,
      merchantUserId,
      feeAmount: posted.fees,
      feeAsset: posted.assetId,
    }),
  );
}

/**
 * Phase 1: freeze the set and the numbers. No external call, no value moved.
 *
 * Returning an already-frozen row is allowed for a non-active merchant (the
 * freeze already happened). Creating a NEW freeze is not — that would lock
 * more payments into a settlement a suspended operator can then try to post.
 */
export async function prepareSettlement(
  svc: PayServiceInternal,
  input: {
    merchantId: string;
    window: string;
    assetId: string;
    from?: Date;
    to?: Date;
  },
): Promise<SettlementRecord> {
  const { from, to } = windowBounds(input.window, input.from, input.to);
  const merchant = await svc.getMerchant(input.merchantId);
  const feeBps = merchant.pricing.feeBps !== undefined ? merchant.pricing.feeBps : publishedDefaultFeeBps(svc.defaultFeeBps);

  return transaction(
    svc.sql,
    async (tx) => {
      // Lock the merchant, not the settlement row (which may not exist yet).
      // Two settlement runs for one merchant must queue, or both would select
      // the same unsettled payments and freeze them into two settlements.
      // Re-read status under the lock so a suspend that races the getMerchant
      // above cannot slip a freeze through.
      const locked = await tx<Array<{ status: MerchantRecord['status']; kyb_status: MerchantRecord['kybStatus'] }>>`
        SELECT status, kyb_status FROM pay.merchants WHERE id = ${input.merchantId} FOR UPDATE
      `;
      const lockedRow = locked[0];
      if (!lockedRow) {
        throw new PayError(`Merchant ${input.merchantId} not found`, 'pay.merchant_not_found');
      }
      await svc.afterSettlementMerchantLock?.();

      const existing = await tx<SettlementRow[]>`
        SELECT id, merchant_id, "window", asset_id, gross, fees, net, payout_method, payout_ref, payout_attempts, status
          FROM pay.settlements
         WHERE merchant_id = ${input.merchantId} AND "window" = ${input.window} AND asset_id = ${input.assetId}
      `;
      if (existing[0]) return toSettlement(existing[0]);

      if (lockedRow.status !== 'active') {
        throw new PayError(`Merchant ${input.merchantId} is ${lockedRow.status}`, 'pay.merchant_inactive');
      }
      const kybRefuse = merchantKybMoneyGateRefusal({
        merchantId: input.merchantId,
        status: lockedRow.status,
        kybStatus: lockedRow.kyb_status,
        valueMovement: svc.valueMovement,
      });
      if (kybRefuse) {
        throw new PayError(kybRefuse.message, kybRefuse.code, kybRefuse.detail);
      }

      // Candidate ids only first — lock each payment FOR UPDATE before reading
      // totals so a concurrent pre-settlement refund cannot drain clearing
      // after we freeze a gross that still included that payment.
      const candidateIds = await tx<Array<{ id: string }>>`
        SELECT p.id
          FROM pay.payments p
         WHERE p.merchant_id = ${input.merchantId}
           AND p.currency = ${input.assetId}
           AND p.status = 'captured'
           AND NOT EXISTS (
             -- Frozen into a settlement that has not been released. A released
             -- inclusion (ops path after desync) is eligible for a later window.
             SELECT 1 FROM pay.payment_events s
              WHERE s.payment_id = p.id AND s.event = 'settlement.included'
                AND NOT EXISTS (
                  SELECT 1 FROM pay.payment_events r
                   WHERE r.payment_id = s.payment_id
                     AND r.event = 'settlement.released'
                     AND r.payload->>'settlementId' = s.payload->>'settlementId'
                )
           )
           AND (
             EXISTS (
               SELECT 1 FROM pay.payment_events c
                WHERE c.payment_id = p.id AND c.event = 'captured' AND c.ts >= ${from} AND c.ts < ${to}
             )
             -- A payment returned by a won dispute or freed by a released window is overdue, so it joins any
             -- window that ends after it came back. Its capture time sits in a window that has already closed.
             -- A payment the rail released after its capture window closed (RC-merchant-10) is overdue the same way.
             OR EXISTS (
               SELECT 1 FROM pay.payment_events c
                WHERE c.payment_id = p.id AND c.event IN ('dispute.restored', 'settlement.released', 'funds.available') AND c.ts < ${to}
             )
           )
           AND NOT EXISTS (
             SELECT 1 FROM pay.payment_events sb
              WHERE sb.payment_id = p.id AND sb.event = 'created' AND sb.payload->>'sandbox' = 'true'
           )
         ORDER BY p.id
         FOR UPDATE OF p
      `;

      let gross = 0n;
      let included: string[] = [];
      const includedNet = new Map<string, Amount>();
      // RC-merchant-10: payments the rail still holds. They join the window only when nothing in it is available yet,
      // and then the window waits for the rail before it posts; otherwise they stay out, in clearing, for a later one.
      let heldGross = 0n;
      const held: string[] = [];
      for (const { id: paymentId } of candidateIds) {
        // Skip payments with an open refund.posted — their clearing is already
        // leaving (or about to leave). Including them freezes a gross the
        // pool no longer holds.
        const openRefund = await tx<Array<{ refund_id: string }>>`
          SELECT p.payload->>'refundId' AS refund_id
            FROM pay.payment_events p
           WHERE p.payment_id = ${paymentId} AND p.event = 'refund.posted'
             AND NOT EXISTS (
               SELECT 1 FROM pay.payment_events d
                WHERE d.payment_id = p.payment_id
                  AND d.event IN ('refunded', 'refund.reversed')
                  AND d.payload->>'refundId' = p.payload->>'refundId'
             )
           LIMIT 1
        `;
        if (openRefund.length > 0) continue;

        const totals = await totalsFor(tx, paymentId);
        const net = totals.captured - totals.refunded;
        if (net <= 0n) continue; // Fully refunded inside the window — nothing to settle.
        includedNet.set(paymentId, net);
        if ((await fundsHeldOf(tx, paymentId)).held) {
          heldGross += net;
          held.push(paymentId);
          continue;
        }
        gross += net;
        included.push(paymentId);
      }
      if (gross <= 0n && heldGross > 0n) {
        gross = heldGross;
        included = held;
      }

      if (gross <= 0n) {
        throw new PayError(
          `Nothing to settle for merchant ${input.merchantId} in ${input.window} (${input.assetId})`,
          'pay.nothing_to_settle',
        );
      }

      // Fees round `ceil` — the house never pays a rounding unit on a merchant's
      // behalf, and the merchant is never short by one either, because net is
      // derived by subtraction rather than computed independently.
      const fees = mulBps(gross, feeBps, 'ceil');
      const net = gross - fees;
      if (net <= 0n) {
        throw new PayError(
          `Fee of ${formatAmount(fees)} consumes the whole ${formatAmount(gross)} window — check merchant pricing`,
          'pay.fee_exceeds_gross',
          { gross: formatAmount(gross), fees: formatAmount(fees), feeBps },
        );
      }

      const inserted = await tx<SettlementRow[]>`
        INSERT INTO pay.settlements (merchant_id, "window", asset_id, gross, fees, net, status)
        VALUES (
          ${input.merchantId}, ${input.window}, ${input.assetId},
          ${formatAmount(gross)}::numeric, ${formatAmount(fees)}::numeric, ${formatAmount(net)}::numeric, 'pending'
        )
        RETURNING id, merchant_id, "window", asset_id, gross, fees, net, payout_method, payout_ref, payout_attempts, status
      `;
      const row = inserted[0]!;

      for (const paymentId of included) {
        await appendEvent(tx, paymentId, 'settlement.included', {
          settlementId: row.id,
          window: input.window,
          assetId: input.assetId,
          // Captured minus refunded at freeze. The line read uses this, not the
          // payment's face amount, so the lines sum to the frozen gross.
          amount: formatAmount(includedNet.get(paymentId)!),
        });
      }

      return toSettlement(row);
    },
    { isolation: 'read committed', maxAttempts: 5 },
  );
}

/**
 * G3 — release a stuck `pending` settlement so its payments can re-enter a
 * later window.
 *
 * After freeze, if post can never succeed (desync), payments stay marked
 * `settlement.included` forever and no later freeze can pick them up. This is
 * the honest ops path: mark the window `failed`, append `settlement.released`
 * per included payment, move no ledger value.
 *
 * HEAL BEFORE RELEASE. Dual-book lag (ledger `merchantSettlement` posted, SQL
 * txn rolled back) leaves the row `pending` while the merchant is already
 * credited. Releasing then would free payments into a later window and
 * double-credit under a new settlement key. Prefer `settleWindow` re-run —
 * which is idempotent on `settlement:<merchant>:<window>:<asset>` — and only
 * release when that re-run refuses as desynced (post truly cannot succeed).
 *
 * Only `pending` windows. Posted/paid_out/failed refuse (failed is idempotent).
 */
export async function releasePendingSettlement(
  svc: PayServiceInternal,
  input: {
    settlementId: string;
    /** Free-text ops reason (journaled; required so silent cancels are impossible). */
    reason: string;
  },
): Promise<SettlementRecord> {
  const reason = input.reason?.trim() ?? '';
  if (!reason) {
    throw new PayError('releasePendingSettlement requires a non-empty reason', 'pay.invalid_transition');
  }

  const head = await svc.sql<SettlementRow[]>`
    SELECT id, merchant_id, "window", asset_id, gross, fees, net, payout_method, payout_ref, payout_attempts, status
      FROM pay.settlements WHERE id = ${input.settlementId}
  `;
  const current = head[0];
  if (!current) throw new PayError(`Settlement ${input.settlementId} not found`, 'pay.settlement_not_found');
  if (current.status === 'failed') return toSettlement(current);
  if (current.status !== 'pending') {
    throw new PayError(
      `Settlement ${current.id} is ${current.status}; only a pending settlement can be released`,
      'pay.settlement_not_pending',
      { settlementId: current.id, status: current.status },
    );
  }

  // Prefer heal by settlement id (not settleWindow — custom window labels need
  // from/to that release does not carry). Ledger re-post is idempotent on
  // settlement:<merchant>:<window>:<asset>; projection catches up. Desync
  // falls through to release, and so does a window still waiting on the rail
  // (RC-merchant-10): an operator's release with a reason frees its payments to
  // a later window, where a held one is still left out, and a released window
  // is never payable (`pay.settlement_released`).
  try {
    const healed = await svc.postPendingSettlement(current.id, { kind: 'recovery', reason: 'window_frozen_not_posted' });
    if (healed.status !== 'pending') return healed;
  } catch (err) {
    if (!(err instanceof PayError) || err.code !== 'pay.settlement_desynced') {
      throw err;
    }
  }

  return transaction(
    svc.sql,
    async (tx) => {
      const rows = await tx<SettlementRow[]>`
        SELECT id, merchant_id, "window", asset_id, gross, fees, net, payout_method, payout_ref, payout_attempts, status
          FROM pay.settlements WHERE id = ${input.settlementId} FOR UPDATE
      `;
      const row = rows[0];
      if (!row) throw new PayError(`Settlement ${input.settlementId} not found`, 'pay.settlement_not_found');
      if (row.status === 'failed') return toSettlement(row);
      if (row.status !== 'pending') {
        // Healed under us, or concurrent post finished.
        return toSettlement(row);
      }

      const included = await tx<Array<{ payment_id: string }>>`
        SELECT payment_id FROM pay.payment_events
         WHERE event = 'settlement.included' AND payload->>'settlementId' = ${row.id}
         ORDER BY payment_id
      `;

      for (const { payment_id } of included) {
        await appendEvent(tx, payment_id, 'settlement.released', {
          settlementId: row.id,
          window: row.window,
          assetId: row.asset_id,
          reason,
        });
      }

      await tx`
        UPDATE pay.settlements
           SET status = 'failed',
               failed_at = now(),
               failure_code = 'pay.settlement_released',
               updated_at = now()
         WHERE id = ${row.id}
      `;

      return toSettlement({ ...row, status: 'failed' });
    },
    { isolation: 'read committed', maxAttempts: 5 },
  );
}

/**
 * Record a rail-health outcome after the money result is durable. A throw here
 * is logged and counted. It does not change a paid_out result or a refusal.
 * Adapter throws count. Destination and customer refusals do not.
 */
export async function accountRailOutcome(
  svc: PayServiceInternal,
  input: {
    kind: 'failure' | 'success' | 'throw';
    target: PayHaltTarget;
    railId: string;
    failureCode?: string | null;
    eventKey?: string;
    connection?: Sql;
  },
): Promise<void> {
  if (!svc.haltStore) return;
  if (input.target.level !== 'merchant' && input.target.level !== 'user') return;
  const sourceKey = payoutRailSourceKey(input.railId);
  try {
    if (input.kind === 'success') {
      await svc.haltStore.recordSuccess('payout', input.target, sourceKey, input.connection);
      return;
    }
    if (input.kind === 'failure' && !isRailHealthFailureCode(input.failureCode)) return;
    await svc.haltStore.recordFailure('payout', input.target, sourceKey, input.connection, input.eventKey);
  } catch (error) {
    noteAutoTripAccountError({
      op: input.kind === 'success' ? 'recordSuccess' : 'recordFailure',
      scope: 'payout',
      target: targetKey(input.target),
      sourceKey,
      name: error instanceof Error ? error.name : 'unknown',
    });
  }
}
