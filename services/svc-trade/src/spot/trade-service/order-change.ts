/**
 * Changing a live order: cancel, amend, replace, cancel all and mass cancel.
 *
 * Moved out of `trade-service.ts` as it was (owner decision 2026-10-23): `TradeService` keeps one method per
 * function here, which passes itself as `svc`.
 */
import { transaction } from '@intafaced/db';
import { requireScope, type Principal } from '@intafaced/auth';
import { formatAmount, LedgerError, orderHoldAccount, parseAmount, recipes, sub, type Amount } from '@intafaced/ledger-client';
import { withMoneySpan } from '../../tracing.js';
import { appendOrderEvent, parentIdFromClientOrder } from '../../orders/order-events.js';
import { orderIdFor } from '../ids.js';
import { settlementOrderId } from '../oco-legs.js';
import {
  assertMarketOpen,
  assertNotional,
  assertPrice,
  assertQty,
  assertSettlementRails,
  assertTradable,
  holdFor,
  protectionPriceFor,
  sellProtectionPriceFor,
  requireSupportedType,
} from '../risk.js';
import { assertOperatorRiskOnPlace } from '../../admin/risk.js';
import { toOrder, type OrderRow } from '../rows.js';
import { assertSubAccountOwned } from '../sub-account-ownership.js';
import { assertEmailProved } from '../email-proof.js';
import { type EngineAmendResult, type MatchingClient } from '../matching-client.js';
import { attributionFromOrder, withLedgerAttribution } from '../auth-attribution.js';
import { type LifecycleAdmissionProof } from '../../lifecycle-proof.js';
import {
  TradeError,
  type Market,
  type MarketKind,
  type OrderRecord,
  type AmendOrderOutcome,
  type AmendOutcomeCode,
  type AmendPriority,
  type ReplaceOrderOutcome,
  type ReplaceOutcomeCode,
} from '../types.js';
import type { AmendOrderInput, PlaceOrderInput, TradeServiceInternal } from '../trade-service.js';
import { replacementClientOrderId, replacementRequestHash } from './internal.js';

/**
 * Cancel an open order and return what is left of its hold (§5.2 step 3).
 *
 * ORDERING: the engine first, this service second. Cancelling at the engine
 * is what makes "no further fills for this order" true; only once it is true
 * can the remainder be computed and released. Releasing first would race a
 * fill that is already in flight, and the release would draw down a hold that
 * a fill is about to need.
 */
export async function cancelOrder(svc: TradeServiceInternal, principal: Principal, orderId: string): Promise<OrderRecord> {
  return withMoneySpan('trade.cancelOrder', { operation: 'cancel_order', userId: principal.userId, orderId }, async () => {
    requireScope(principal, 'trade:write');

    const order = await svc.findOrder(orderId);
    if (!order) throw new TradeError(`order ${orderId} not found`, 'trade.order_not_found');
    if (order.userId !== principal.userId) {
      // Deliberately the same code a stranger's order id would produce — do
      // not confirm the existence of another account's order.
      throw new TradeError(`order ${orderId} not found`, 'trade.order_not_found');
    }
    if (order.status === 'hold_unknown') {
      const read = await svc.readHoldByKey(order.id);
      if (read === 'unknown') {
        svc.noteHoldUnknown({
          orderId,
          resolution: 'still_unknown',
          detail: 'cancel refused until order.hold can be read back',
        });
        throw new TradeError(`order ${orderId} hold outcome is still unknown`, 'trade.hold_unknown');
      }
      if (read === 'absent') {
        const wait = await svc.holdUnknownWaitSeconds(orderId);
        if (wait > 0) {
          svc.noteHoldUnknown({
            orderId,
            resolution: 'still_unknown',
            detail: `cancel refused; order.hold read absent with ${wait}s of in-flight wait left`,
          });
          throw new TradeError(
            `order ${orderId} hold outcome is unknown; wait ${wait} seconds before treating an absent hold as dead`,
            'trade.hold_unknown',
          );
        }
        const cancelled = await svc.cancelAbsentHoldUnknownPastBound(orderId);
        if (cancelled === 0) {
          const current = await svc.findOrder(orderId);
          if (current?.status === 'hold_unknown') {
            const wait = await svc.holdUnknownWaitSeconds(orderId);
            svc.noteHoldUnknown({
              orderId,
              resolution: 'still_unknown',
              detail: `cancel write matched no row; ${wait}s of in-flight wait left`,
            });
            throw new TradeError(
              `order ${orderId} hold outcome is unknown; wait ${wait} seconds before treating an absent hold as dead`,
              'trade.hold_unknown',
            );
          }
          throw new TradeError(`order ${orderId} is being resolved; retry`, 'trade.hold_unknown');
        }
        const settled = await svc.findOrder(orderId);
        if (!settled) throw new TradeError(`order ${orderId} not found`, 'trade.order_not_found');
        return settled;
      }
      // Hold is booked and the engine was never given this order. Claim it,
      // then release the full hold. Do not ask matching to cancel.
      const claimed = await svc.sql<Array<{ id: string }>>`
        UPDATE trade.orders SET status = 'open', updated_at = now()
         WHERE id = ${orderId} AND status = 'hold_unknown'
         RETURNING id
      `;
      if (claimed.length === 0) {
        throw new TradeError(`order ${orderId} is being resolved; retry`, 'trade.hold_unknown');
      }
      await svc.finalize(orderId, 'cancelled');
      const settled = await svc.findOrder(orderId);
      if (!settled) throw new TradeError(`order ${orderId} not found`, 'trade.order_not_found');
      return settled;
    } else if (order.status !== 'open' && order.status !== 'pending' && order.status !== 'recovery_required') {
      throw new TradeError(`order ${orderId} is ${order.status} and cannot be cancelled`, 'trade.order_not_open');
    }

    // `cancelled: false` means the engine has no such live order — it already
    // filled, or it never arrived (the indeterminate-submit case above).
    // Either way the hold still has to be reconciled, so the answer is the
    // same and this is not an error path.
    let cancellation: Awaited<ReturnType<MatchingClient['cancel']>>;
    try {
      cancellation = await svc.matching.cancel(order.marketId, orderId);
    } catch (err) {
      // A cancel timeout is itself OUTCOME_UNKNOWN. Do not release on an
      // unproven cancel; recovery uses the stable key below.
      await svc.markRecoveryRequired(orderId, 'CANCEL_UNKNOWN');
      throw err;
    }

    // A false cancel response claims absence, but verify that claim with the
    // non-destructive list before releasing. If the lookup is ambiguous or
    // still live, preserve the hold and surface a cancel recovery case.
    if (!cancellation.cancelled) {
      try {
        const listed = await svc.matching.listOrders(order.marketId, orderId);
        if (listed.orders.some((candidate) => settlementOrderId(candidate.orderId) === orderId)) {
          await svc.markRecoveryRequired(orderId, 'CANCEL_UNKNOWN');
          throw new TradeError(`order ${orderId} remains live after definitive cancel miss`, 'trade.order_not_open');
        }
      } catch (err) {
        if (err instanceof TradeError) throw err;
        await svc.markRecoveryRequired(orderId, 'CANCEL_UNKNOWN');
        throw err;
      }
    }

    // Keep the engine's own remainder, the first answer only: a retry after the engine already cancelled reads absent.
    if (cancellation.cancelled && cancellation.cancellation) {
      await svc.sql`
        UPDATE trade.orders SET engine_left_qty = ${cancellation.cancellation.remainingQty}::numeric
         WHERE id = ${orderId} AND engine_left_qty IS NULL
      `;
    }
    // The engine matched part of this order just before the cancel, and the taker's settlement has not written that
    // fill yet. Closing now would release the hold the fill is about to draw, and a caller that places again (a chase
    // re-price) would count that quantity twice. The order stays as it is; the engine's cancel event closes it once
    // the fill lands (`releaseOnCancelEvent` waits the same way). A retry reads the stored remainder, not the miss.
    const [answer] = await svc.sql<Array<{ engine_left_qty: string | null }>>`
      SELECT engine_left_qty::text AS engine_left_qty FROM trade.orders WHERE id = ${orderId}
    `;
    if (answer?.engine_left_qty != null) {
      try {
        await svc.refuseCancelAheadOfFill(orderId, parseAmount(answer.engine_left_qty));
      } catch (err) {
        if (err instanceof TradeError && err.code === 'trade.cancel_ahead_of_fill') return (await svc.findOrder(orderId)) as OrderRecord;
        throw err;
      }
    } else if (!cancellation.cancelled) {
      // No live order and no earlier answer: it may have matched in full. Said on the row, for a chase to read.
      await svc.sql`UPDATE trade.orders SET engine_absent_at_cancel = true WHERE id = ${orderId}`;
    }

    // A successful cancel or a verified engine absence is now safe to
    // reconcile. Transport ambiguity above is deliberately kept separate and
    // remains recovery-required.
    await svc.finalize(orderId, 'cancelled');

    const settled = await svc.findOrder(orderId);
    return settled as OrderRecord;
  });
}

/**
 * Native amend (PX-S03 §8.2) — one matching PATCH, same order id.
 *
 * Only spot qty-down at the same price is native: that is the case that
 * retains queue priority and whose hold shrinks by a proven remainder.
 * Side, market, type, price, TIF, and qty-up stay CANCEL_REPLACE / NOT_AMENDABLE
 * and never silently cancel-plus-new. Unknown matching outcome never releases.
 */
export async function amendOrder(
  svc: TradeServiceInternal,
  principal: Principal,
  orderId: string,
  input: AmendOrderInput,
): Promise<AmendOrderOutcome> {
  return withMoneySpan('trade.amendOrder', { operation: 'amend_order', userId: principal.userId, orderId }, async () => {
    requireScope(principal, 'trade:write');

    const order = await svc.findOrder(orderId);
    if (!order || order.userId !== principal.userId) {
      throw new TradeError(`order ${orderId} not found`, 'trade.order_not_found');
    }
    if (order.status === 'recovery_required') {
      return svc.amendOutcome(order, 'AMEND_UNKNOWN', order.recoveryReason ?? 'AMEND_UNKNOWN', true, false, null);
    }
    if (order.status !== 'open') {
      return svc.amendOutcome(order, 'NOT_AMENDABLE', 'trade.order_not_open', false, false, null);
    }

    if (input.side != null && input.side !== order.side) {
      return svc.amendOutcome(order, 'CANCEL_REPLACE', 'trade.amend_side_change', false, false, null);
    }
    if (input.type != null && input.type !== order.type) {
      return svc.amendOutcome(order, 'CANCEL_REPLACE', 'trade.amend_type_change', false, false, null);
    }
    if (input.tif != null && input.tif !== order.tif) {
      return svc.amendOutcome(order, 'CANCEL_REPLACE', 'trade.amend_tif_change', false, false, null);
    }
    if (input.price != null && order.price != null && input.price !== order.price) {
      return svc.amendOutcome(order, 'CANCEL_REPLACE', 'trade.amend_price_change', false, false, null);
    }
    if (input.marketId != null && input.marketId !== order.marketId) {
      return svc.amendOutcome(order, 'CANCEL_REPLACE', 'trade.replace_market_mismatch', false, false, null);
    }

    const market = await svc.marketById(order.marketId);
    if (!market) throw new TradeError(`market ${order.marketId} not found`, 'trade.market_not_found');
    if (input.symbol != null && input.symbol !== market.symbol) {
      return svc.amendOutcome(order, 'CANCEL_REPLACE', 'trade.replace_market_mismatch', false, false, null);
    }

    if (market.kind !== 'spot' || market.paper) {
      return svc.amendOutcome(order, 'NOT_AMENDABLE', 'trade.market_kind_unsupported', false, false, null);
    }
    if (order.type !== 'limit' || order.price == null) {
      return svc.amendOutcome(order, 'NOT_AMENDABLE', 'trade.invalid_price', false, false, null);
    }
    if (order.tif === 'IOC' || order.tif === 'FOK') {
      return svc.amendOutcome(order, 'NOT_AMENDABLE', 'trade.order_not_open', false, false, null);
    }
    if (input.qty <= 0n) {
      throw new TradeError('amend quantity must be strictly positive', 'trade.invalid_qty');
    }

    const remainingQty = sub(order.qty, order.filledQty);
    if (remainingQty <= 0n) {
      return svc.amendOutcome(order, 'NOT_AMENDABLE', 'trade.order_not_open', false, false, null);
    }
    if (input.qty > remainingQty) {
      // Qty-up needs a larger hold. Native amend will not invent one.
      return svc.amendOutcome(order, 'NOT_AMENDABLE', 'trade.amend_qty_up', false, false, null);
    }

    try {
      assertTradable(market, {
        futuresEnabled: svc.futuresEnabled,
        optionsSettlementLawStamped: svc.optionsSettlementAssetLaw.trim().length > 0,
      });
      assertSettlementRails(market);
      assertMarketOpen(market, svc.now());
      assertQty(market, input.qty);
      assertPrice(market, order.price);
      assertNotional(market, order.price, input.qty);
    } catch (err) {
      if (err instanceof TradeError) {
        return svc.amendOutcome(order, 'NOT_AMENDABLE', err.code, false, false, null);
      }
      throw err;
    }

    let lifecycleProof: LifecycleAdmissionProof;
    try {
      lifecycleProof = await svc.assertLifecycleAction(market, 'AMEND');
    } catch (err) {
      if (err instanceof TradeError && err.code.startsWith('trade.lifecycle_')) {
        return svc.amendOutcome(order, 'LIFECYCLE_REFUSED', err.code, false, false, null);
      }
      if (err instanceof TradeError && (err.code === 'trade.market_halted' || err.code === 'trade.market_suspended')) {
        return svc.amendOutcome(order, 'LIFECYCLE_REFUSED', err.code, false, false, null);
      }
      throw err;
    }

    const newHold = holdFor(market, order.side, order.price, input.qty).amount;
    const leftover = await svc.remainingHold(svc.sql, order);
    if (leftover < newHold) {
      return svc.amendOutcome(order, 'NOT_AMENDABLE', 'trade.hold_uncovered', false, false, null);
    }

    let listed;
    try {
      listed = await svc.matching.listOrders(order.marketId, order.id);
    } catch {
      await svc.markRecoveryRequired(order.id, 'AMEND_UNKNOWN');
      const frozen = (await svc.findOrder(order.id)) ?? order;
      return svc.amendOutcome(frozen, 'AMEND_UNKNOWN', 'AMEND_UNKNOWN', true, false, null);
    }
    const live = listed.orders.find((candidate) => candidate.orderId === order.id);
    if (!live) {
      await svc.markRecoveryRequired(order.id, 'AMEND_UNKNOWN');
      const frozen = (await svc.findOrder(order.id)) ?? order;
      return svc.amendOutcome(frozen, 'AMEND_UNKNOWN', 'AMEND_UNKNOWN', true, false, null);
    }

    const engineRemaining = parseAmount(live.remaining);
    const expectedVersion = live.version ?? order.engineVersion;
    if (input.expectedRemaining != null && input.expectedRemaining !== engineRemaining) {
      return svc.amendOutcome(order, 'NOT_AMENDABLE', 'trade.amend_stale', false, false, null);
    }
    if (input.expectedVersion != null && input.expectedVersion !== expectedVersion) {
      return svc.amendOutcome(order, 'NOT_AMENDABLE', 'trade.amend_stale', false, false, null);
    }
    if (engineRemaining === input.qty) {
      await svc.applyNativeAmendHold(order, market, input.qty, expectedVersion, live.sequence);
      const settled = (await svc.findOrder(order.id)) ?? order;
      return svc.amendOutcome(settled, 'IDEMPOTENT_RETRY', null, false, true, 'retained');
    }
    if (engineRemaining < input.qty) {
      return svc.amendOutcome(order, 'NOT_AMENDABLE', 'trade.amend_qty_up', false, false, null);
    }

    let result: EngineAmendResult;
    try {
      result = await svc.matching.amend(order.marketId, order.id, {
        expectedVersion,
        qty: formatAmount(input.qty),
        lifecycleProof,
      });
    } catch {
      await svc.markRecoveryRequired(order.id, 'AMEND_UNKNOWN');
      const frozen = (await svc.findOrder(order.id)) ?? order;
      return svc.amendOutcome(frozen, 'AMEND_UNKNOWN', 'AMEND_UNKNOWN', true, false, null);
    }

    if (!result.accepted) {
      if (result.rejected?.code === 'order_not_found') {
        await svc.markRecoveryRequired(order.id, 'AMEND_UNKNOWN');
        const frozen = (await svc.findOrder(order.id)) ?? order;
        return svc.amendOutcome(frozen, 'AMEND_UNKNOWN', 'AMEND_UNKNOWN', true, false, null);
      }
      if (result.rejected?.code === 'version_mismatch') {
        return svc.amendOutcome(order, 'VERSION_MISMATCH', 'version_mismatch', false, false, null);
      }
      return svc.amendOutcome(order, 'ENGINE_REFUSED', result.rejected?.code ?? 'refused', false, false, null);
    }

    await svc.settleOutcome(market, result.fills, result.cancellations);
    const afterFills = (await svc.findOrder(order.id)) ?? order;
    if (afterFills.status !== 'open' && afterFills.status !== 'recovery_required') {
      return svc.amendOutcome(afterFills, 'AMENDED', null, false, false, result.priority);
    }

    const version = result.version ?? expectedVersion + 1;
    await svc.applyNativeAmendHold(afterFills, market, input.qty, version, result.sequence);
    const settled = (await svc.findOrder(order.id)) ?? afterFills;
    return svc.amendOutcome(settled, 'AMENDED', null, false, false, result.priority);
  });
}

export function amendOutcome(
  svc: TradeServiceInternal,
  order: OrderRecord,
  code: AmendOutcomeCode,
  reasonCode: string | null,
  reconciliationRequired: boolean,
  idempotent: boolean,
  priority: AmendPriority | null,
): AmendOrderOutcome {
  return {
    accepted: code === 'AMENDED' || code === 'IDEMPOTENT_RETRY',
    idempotent,
    code,
    reasonCode,
    reconciliationRequired,
    path: 'NATIVE_AMEND',
    priority,
    order,
  };
}

/**
 * After a proven engine remaining, shrink qty and post the exact leftover
 * hold. Sequence is the new instruction version so it never collides with
 * the terminal sequence-0 release.
 *
 * Qty is the committed fill sum plus the new remaining. `filled_qty` is a
 * cache `refreshFilledQty` rewrites after the fill row commits and before
 * `tradeFill` posts. Using the cache can store a qty below that sum; the
 * overfill check then rejects every refresh and the hold slice
 * `remainingHold` already counted stays in the order-hold account.
 */
export async function applyNativeAmendHold(
  svc: TradeServiceInternal,
  order: OrderRecord,
  market: Market,
  newRemaining: Amount,
  version: number,
  sequence: number | null,
): Promise<void> {
  if (order.price == null) return;
  // The release post commits in the ledger on its own. If it lands and this
  // transaction then aborts, amend_released rolls back and the terminal
  // sequence-0 release would pay the same qty-down again (an unsettled fill
  // keeps the pot above the stale remainder, so the pot cap alone hides
  // nothing). Survives a serialization retry: the retry's pot is already
  // reduced, so a fresh before-balance would look like the post never landed.
  let landedThenCrashed: unknown = null;
  let potBeforeRelease: Amount | null = null;
  await transaction(
    svc.sql,
    async (tx) => {
      const rows = await tx<OrderRow[]>`SELECT * FROM trade.orders WHERE id = ${order.id} FOR UPDATE`;
      const row = rows[0];
      if (!row) return;
      const locked = toOrder(row);
      if (locked.status !== 'open' && locked.status !== 'recovery_required') return;
      if (locked.price == null) return;

      const leftover = await svc.remainingHold(tx, locked);
      const newHold = holdFor(market, locked.side, locked.price, newRemaining).amount;
      if (leftover < newHold) {
        throw new TradeError(
          `order ${locked.id} remaining hold ${formatAmount(leftover)} cannot cover amended hold ${formatAmount(newHold)}`,
          'trade.hold_uncovered',
        );
      }
      const release = sub(leftover, newHold);
      if (release > 0n) {
        const holdRef = orderHoldAccount(locked.userId, locked.holdAsset, locked.id);
        const potBefore = potBeforeRelease ?? (await svc.ledger.balance(holdRef)).amount;
        potBeforeRelease = potBefore;
        try {
          await svc.ledger.post(
            withLedgerAttribution(
              recipes.orderHoldRelease({
                orderId: locked.id,
                userId: locked.userId,
                assetId: locked.holdAsset,
                amount: release,
                sequence: version,
              }),
              attributionFromOrder(locked),
            ),
          );
        } catch (err) {
          // A throw after the commit: if the pot fell by this release the
          // post landed, so record it and surface the error afterwards.
          const potAfter = (await svc.ledger.balance(holdRef)).amount;
          if (sub(potBefore, potAfter) !== release) throw err;
          landedThenCrashed = err;
        }
      }
      const filledRows = await tx<Array<{ filled: string }>>`
        SELECT COALESCE(SUM(qty), 0)::numeric(38, 18)::text AS filled
          FROM trade.fills
         WHERE order_id = ${locked.id}
      `;
      const committedFilled = parseAmount(filledRows[0]?.filled ?? '0');
      const newQty = committedFilled + newRemaining;
      const amendReleased = locked.amendReleased + release;
      await appendOrderEvent(tx, {
        orderId: locked.id,
        parentId: parentIdFromClientOrder(locked.clientOrderId),
        kind: 'amend',
        quantity: formatAmount(newQty),
        price: formatAmount(locked.price),
        code: `amend:${version}`,
      });
      await tx`
        UPDATE trade.orders
           SET qty = ${formatAmount(newQty)}::numeric,
               amend_released = ${formatAmount(amendReleased)}::numeric,
               engine_version = ${version},
               engine_sequence = COALESCE(${sequence}, engine_sequence),
               status = 'open',
               recovery_reason = NULL,
               reconciliation_key = NULL,
               updated_at = now()
         WHERE id = ${locked.id}
      `;
    },
    { isolation: 'read committed', maxAttempts: 5 },
  );
  if (landedThenCrashed) throw landedThenCrashed;
}

/**
 * Cancel/replace is a named CANCEL_REPLACE saga, never native amend:
 *
 *   1. prove the caller and replacement are admissible;
 *   2. cancel the original through the engine and finalize its ledger hold;
 *   3. submit the replacement through the ordinary funded place path.
 *
 * The replacement key is persisted on the replacement row. A retry therefore
 * returns the same row, while a different request using that key is refused.
 * No replacement is attempted after a partial/terminal original or any
 * unresolved cancel/reconciliation state. Side/market change belongs here,
 * not on the native PATCH door.
 */
export async function replaceOrder(
  svc: TradeServiceInternal,
  principal: Principal,
  originalOrderId: string,
  input: PlaceOrderInput,
): Promise<ReplaceOrderOutcome> {
  return withMoneySpan(
    'trade.replaceOrder',
    { operation: 'replace_order', userId: principal.userId, orderId: originalOrderId },
    async () => {
      requireScope(principal, 'trade:write');

      const original = await svc.findOrder(originalOrderId);
      if (!original || original.userId !== principal.userId) {
        throw new TradeError(`order ${originalOrderId} not found`, 'trade.order_not_found');
      }
      if (!input.clientOrderId || input.clientOrderId.length < 1 || input.clientOrderId.length > 56) {
        throw new TradeError('replacement clientOrderId is required (1–56 chars)', 'trade.client_order_id_required');
      }

      const market = await svc.requireMarket(input);
      if (market.id !== original.marketId) {
        return svc.replaceOutcome(original, null, 'ORIGINAL_NOT_REPLACEABLE', 'trade.replace_market_mismatch');
      }
      if (market.kind !== 'spot' || market.paper) {
        return svc.replaceOutcome(original, null, 'ORIGINAL_NOT_REPLACEABLE', 'trade.market_kind_unsupported');
      }
      const requestHash = replacementRequestHash(original.id, input);
      const replacementClientId = replacementClientOrderId(input.clientOrderId);
      const replacementId = orderIdFor(principal.userId, market.id, replacementClientId);
      const requestFence = await svc.sql<Array<{ original_order_id: string; request_hash: string; replacement_order_id: string | null }>>`
        INSERT INTO trade.order_replace_requests
          (user_id, market_id, client_order_id, original_order_id, request_hash)
        VALUES
          (${principal.userId}, ${market.id}, ${input.clientOrderId}, ${original.id}, ${requestHash})
        ON CONFLICT (user_id, market_id, client_order_id) DO NOTHING
        RETURNING original_order_id, request_hash, replacement_order_id
      `;
      const requestAlreadyExists = requestFence.length === 0;
      if (requestAlreadyExists) {
        const prior = await svc.sql<Array<{ original_order_id: string; request_hash: string; replacement_order_id: string | null }>>`
          SELECT original_order_id, request_hash, replacement_order_id
            FROM trade.order_replace_requests
           WHERE user_id = ${principal.userId}
             AND market_id = ${market.id}
             AND client_order_id = ${input.clientOrderId}
        `;
        const priorRow = prior[0];
        if (!priorRow || priorRow.original_order_id !== original.id || priorRow.request_hash !== requestHash) {
          return svc.replaceOutcome(original, null, 'REPLACE_CONFLICT', 'trade.replace_conflict');
        }
      }
      const existingReplacement = await svc.findOrder(replacementId);
      if (existingReplacement) {
        if (existingReplacement.replacementOf !== original.id || existingReplacement.replacementRequestHash !== requestHash) {
          return svc.replaceOutcome(original, null, 'REPLACE_CONFLICT', 'trade.replace_conflict');
        }
        return svc.replaceOutcome(
          original,
          existingReplacement,
          existingReplacement.status === 'recovery_required' ? 'REPLACEMENT_SUBMIT_UNKNOWN' : 'IDEMPOTENT_RETRY',
          existingReplacement.recoveryReason,
          existingReplacement.status === 'recovery_required',
          true,
        );
      }

      if (original.status === 'recovery_required') {
        return svc.replaceOutcome(
          original,
          null,
          'RECONCILIATION_REQUIRED',
          original.recoveryReason ?? 'RECONCILIATION_REQUIRED',
          true,
          requestAlreadyExists,
        );
      }
      if (original.filledQty > 0n) {
        return svc.replaceOutcome(original, null, 'ORIGINAL_PARTIAL', 'trade.replace_partial_original', false, requestAlreadyExists);
      }
      if (original.status !== 'open') {
        return svc.replaceOutcome(original, null, 'ORIGINAL_NOT_REPLACEABLE', 'trade.order_not_open', false, requestAlreadyExists);
      }

      // Ownership is checked before the original is cancelled. A replacement
      // must never cancel a live order and then discover its new label is foreign.
      if (input.subAccountId != null) await assertSubAccountOwned(svc.subAccounts, principal.userId, input.subAccountId);
      // Email proof before the cancel too: a refused replacement leaves the original live.
      if (!market.paper) await assertEmailProved(svc.emailProof, principal.userId);
      const orderType = requireSupportedType(input.type);
      assertTradable(market, {
        futuresEnabled: svc.futuresEnabled,
        optionsSettlementLawStamped: svc.optionsSettlementAssetLaw.trim().length > 0,
      });
      assertSettlementRails(market);
      assertMarketOpen(market, svc.now());
      assertQty(market, input.qty);
      if (orderType === 'limit') {
        if (input.price == null) throw new TradeError('a limit order requires a price', 'trade.invalid_price');
        assertPrice(market, input.price);
        assertNotional(market, input.price, input.qty);
      } else if (input.price != null) {
        throw new TradeError('a market order must not carry a price', 'trade.invalid_price');
      }

      // Owner max-order limit (#4725) BEFORE the cancel: a refused replacement
      // must leave the original order live, never cancel it and then refuse.
      if (input.seeded !== true && (input as { reduceOnly?: boolean }).reduceOnly !== true) {
        try {
          let reference: Amount | null = input.price ?? null;
          if (reference == null && input.side === 'buy') {
            reference = protectionPriceFor(market, await svc.bestAsk(market.id), await svc.slippageCap(market.id));
            const cap = input.maxProtectionPrice;
            if (cap != null && cap > 0n && cap < reference) reference = cap;
          }
          await svc.assertOwnerOrderLimit(market, input.qty, reference);
        } catch (err) {
          if (err instanceof TradeError && (err.code.startsWith('trade.limit_max_') || /^trade\.max_.+_unset$/.test(err.code))) {
            return svc.replaceOutcome(original, null, 'LIMIT_REFUSED', err.code, false, requestAlreadyExists);
          }
          throw err;
        }
      }

      // A market sell with no floor must refuse before the original is cancelled.
      if (orderType === 'market' && input.side === 'sell') {
        try {
          sellProtectionPriceFor(market, await svc.bestBid(market.id), await svc.slippageCap(market.id));
        } catch (err) {
          if (err instanceof TradeError && (err.code === 'trade.protection_unset' || err.code === 'trade.no_reference_price')) {
            return svc.replaceOutcome(original, null, 'ORIGINAL_NOT_REPLACEABLE', err.code, false, requestAlreadyExists);
          }
          throw err;
        }
      }

      // The operator's limits for this pair (fat finger, price band, published rules) BEFORE the cancel, the same gate
      // place runs: a replacement priced outside the band is refused with the original still live. The replacement
      // takes the original's slot, so the open-order cap does not count it.
      // A paper market was refused above, so this is always the funded gate.
      try {
        await assertOperatorRiskOnPlace(
          svc.sql,
          market,
          principal.userId,
          { side: input.side, price: input.price ?? null, qty: input.qty, rests: false },
          () => svc.touch(market.id),
          !svc.allowUnpublishedPairRules,
        );
      } catch (err) {
        if (err instanceof TradeError) {
          return svc.replaceOutcome(original, null, 'LIMIT_REFUSED', err.code, false, requestAlreadyExists);
        }
        throw err;
      }

      // Authority is required before cancel, so an unavailable PX-S01 source
      // cannot strand the caller by cancelling an order it cannot replace.
      try {
        await svc.assertLifecycleAction(market, input.tif === 'PO' ? 'PLACE_POST_ONLY' : 'PLACE', orderType);
      } catch (err) {
        if (err instanceof TradeError && err.code.startsWith('trade.lifecycle_')) {
          return svc.replaceOutcome(original, null, 'LIFECYCLE_REFUSED', err.code, false, requestAlreadyExists);
        }
        throw err;
      }

      let cancelled: OrderRecord;
      try {
        cancelled = await svc.cancelOrder(principal, original.id);
      } catch (err) {
        const afterCancel = await svc.findOrder(original.id);
        const racedReplacement = await svc.findOrder(replacementId);
        if (racedReplacement?.replacementOf === original.id && racedReplacement.replacementRequestHash === requestHash) {
          return svc.replaceOutcome(
            afterCancel ?? original,
            racedReplacement,
            racedReplacement.status === 'recovery_required' ? 'REPLACEMENT_SUBMIT_UNKNOWN' : 'IDEMPOTENT_RETRY',
            racedReplacement.recoveryReason,
            racedReplacement.status === 'recovery_required',
            true,
          );
        }
        if (afterCancel?.recoveryReason === 'CANCEL_UNKNOWN') {
          return svc.replaceOutcome(afterCancel, null, 'CANCEL_UNKNOWN', 'CANCEL_UNKNOWN', true, requestAlreadyExists);
        }
        if (afterCancel?.status === 'recovery_required') {
          return svc.replaceOutcome(
            afterCancel,
            null,
            'RECONCILIATION_REQUIRED',
            afterCancel.recoveryReason ?? 'RECONCILIATION_REQUIRED',
            true,
            requestAlreadyExists,
          );
        }
        // The engine may already be cancelled while finalization failed at
        // the ledger boundary. Freeze the original rather than pretending
        // the release completed or attempting a replacement hold.
        if (afterCancel?.status === 'open' || afterCancel?.status === 'pending') {
          await svc.markRecoveryRequired(original.id, 'RECONCILIATION_REQUIRED');
          const frozen = (await svc.findOrder(original.id)) ?? afterCancel;
          return svc.replaceOutcome(frozen, null, 'RECONCILIATION_REQUIRED', 'RECONCILIATION_REQUIRED', true, requestAlreadyExists);
        }
        throw err;
      }
      if (cancelled.status !== 'cancelled') {
        return svc.replaceOutcome(cancelled, null, 'RECONCILIATION_REQUIRED', 'RECONCILIATION_REQUIRED', true, requestAlreadyExists);
      }

      const replacementInput: PlaceOrderInput = {
        ...input,
        // A replacement pays its fees as the order it replaces chose to (fee-ifc.ts), unless the request says otherwise.
        ...(input.feeCurrency === undefined && original.feeCurrency ? { feeCurrency: original.feeCurrency } : {}),
        marketId: market.id,
        clientOrderId: replacementClientId,
        replacementOf: original.id,
        replacementRequestHash: requestHash,
      };
      try {
        const replacement = await svc.placeOrder(principal, replacementInput);
        await svc.sql`
          UPDATE trade.order_replace_requests
             SET replacement_order_id = ${replacement.id}
           WHERE user_id = ${principal.userId}
             AND market_id = ${market.id}
             AND client_order_id = ${input.clientOrderId}
        `;
        return svc.replaceOutcome(cancelled, replacement, 'REPLACED', null, false);
      } catch (err) {
        const persistedReplacement = await svc.findOrder(replacementId);
        if (persistedReplacement?.replacementOf === original.id && persistedReplacement.replacementRequestHash === requestHash) {
          if (persistedReplacement.status === 'recovery_required') {
            await svc.sql`
              UPDATE trade.order_replace_requests
                 SET replacement_order_id = ${persistedReplacement.id}
               WHERE user_id = ${principal.userId}
                 AND market_id = ${market.id}
                 AND client_order_id = ${input.clientOrderId}
            `;
            return svc.replaceOutcome(
              cancelled,
              persistedReplacement,
              'REPLACEMENT_SUBMIT_UNKNOWN',
              persistedReplacement.recoveryReason,
              true,
            );
          }
          return svc.replaceOutcome(cancelled, persistedReplacement, 'IDEMPOTENT_RETRY', null, false, true);
        }
        // The original is already cancelled. Any failure that did not persist
        // a replacement — a refused hold, a frozen ledger, a typed trade
        // refusal — must name REPLACEMENT_NOT_SUBMITTED and the original's
        // final state. A bare 400 here is how a customer loses the order silently.
        const finalOriginal = (await svc.findOrder(original.id)) ?? cancelled;
        if (err instanceof TradeError || err instanceof LedgerError) {
          return svc.replaceOutcome(finalOriginal, null, 'REPLACEMENT_NOT_SUBMITTED', err.code);
        }
        return svc.replaceOutcome(finalOriginal, null, 'REPLACEMENT_NOT_SUBMITTED', 'REPLACEMENT_NOT_SUBMITTED');
      }
    },
  );
}

export function replaceOutcome(
  svc: TradeServiceInternal,
  original: OrderRecord,
  replacement: OrderRecord | null,
  code: ReplaceOutcomeCode,
  reasonCode: string | null,
  reconciliationRequired: boolean,
  idempotent: boolean,
): ReplaceOrderOutcome {
  return {
    accepted: code === 'REPLACED' || code === 'IDEMPOTENT_RETRY',
    idempotent,
    code,
    reasonCode,
    reconciliationRequired,
    original,
    replacement,
  };
}

/**
 * Cancel every open/pending order for the principal (optional market filter).
 * Sequential on purpose: each cancel is its own hold-release money path.
 */
export async function cancelAllOrders(
  svc: TradeServiceInternal,
  principal: Principal,
  marketId?: string,
  kind?: MarketKind,
): Promise<OrderRecord[]> {
  requireScope(principal, 'trade:write');
  // Mutation, not a list door: pull every rest for this principal. openOrders is a
  // published page and must not silently leave orders past LIMIT uncancelled.
  // `kind` narrows to one product's markets ("spot only" leaves futures and options orders alone).
  const rows = marketId
    ? await svc.sql<OrderRow[]>`
        SELECT * FROM trade.orders
         WHERE user_id = ${principal.userId} AND status IN ('pending', 'open', 'recovery_required', 'hold_unknown') AND market_id = ${marketId}
           AND (${kind ?? null}::text IS NULL OR market_id IN (SELECT id FROM trade.markets WHERE kind::text = ${kind ?? null}))
         ORDER BY created_at DESC
      `
    : await svc.sql<OrderRow[]>`
        SELECT * FROM trade.orders
         WHERE user_id = ${principal.userId} AND status IN ('pending', 'open', 'recovery_required', 'hold_unknown')
           AND (${kind ?? null}::text IS NULL OR market_id IN (SELECT id FROM trade.markets WHERE kind::text = ${kind ?? null}))
         ORDER BY created_at DESC
      `;
  const open = rows.map(toOrder);
  const out: OrderRecord[] = [];
  let holdUnknown: TradeError | null = null;
  for (const order of open) {
    try {
      out.push(await svc.cancelOrder(principal, order.id));
    } catch (err) {
      if (err instanceof TradeError && err.code === 'trade.hold_unknown') {
        holdUnknown ??= err;
        continue;
      }
      throw err;
    }
  }
  if (holdUnknown) throw holdUnknown;
  return out;
}

/**
 * Matching mass-cancel for this principal on one market.
 * Owner is the authenticated account. Trade never sends another account or a session.
 * Engine first, then one finalize per pulled rest — unknown outcome does not release.
 */
export async function massCancelOrders(svc: TradeServiceInternal, principal: Principal, marketId: string): Promise<OrderRecord[]> {
  return withMoneySpan('trade.massCancelOrders', { operation: 'mass_cancel', userId: principal.userId, marketId }, async () => {
    requireScope(principal, 'trade:write');
    const accountId = principal.userId;
    if (accountId.length === 0) {
      throw new TradeError('missing account cannot mass-cancel; trade does not invent an owner', 'trade.not_owner');
    }

    const market = await svc.marketById(marketId);
    if (!market) {
      throw new TradeError(`market ${marketId} not found`, 'trade.market_not_found');
    }

    let result: Awaited<ReturnType<MatchingClient['massCancel']>>;
    try {
      result = await svc.matching.massCancel(market.id, { accountId });
    } catch (err) {
      throw err;
    }

    if (!result.accepted) {
      throw new TradeError(result.rejected?.message ?? 'mass-cancel refused', 'trade.order_not_open');
    }

    const out: OrderRecord[] = [];
    // Every leg's end is recorded before any parent closes: an OCO parent closes on its second leg.
    for (const cancellation of result.cancellations) {
      if (cancellation.accountId === accountId)
        await svc.recordOcoLegEnd(cancellation.orderId, cancellation.remainingQty, cancellation.reason);
    }
    for (const cancellation of result.cancellations) {
      if (cancellation.accountId !== accountId) continue;
      const order = await svc.findOrder(settlementOrderId(cancellation.orderId));
      if (!order || order.userId !== principal.userId) continue;
      if (order.status !== 'open' && order.status !== 'pending' && order.status !== 'recovery_required') continue;
      await svc.finalize(cancellation.orderId, 'cancelled');
      const settled = await svc.findOrder(order.id);
      if (settled && !out.some((o) => o.id === settled.id)) out.push(settled);
    }
    return out;
  });
}
