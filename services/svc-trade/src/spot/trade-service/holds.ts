/**
 * Holds and fees: fee rates for a fill, the remaining hold, finalizing an order, and the hold-unknown recovery sweep.
 *
 * Moved out of `trade-service.ts` as it was (owner decision 2026-10-23): `TradeService` keeps one method per
 * function here, which passes itself as `svc`.
 */
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { formatAmount, parseAmount, recipes, type Amount } from '@intafaced/ledger-client';
import { appendOrderEvent, parentIdFromClientOrder } from '../../orders/order-events.js';
import { FeeScheduleError, REGULAR_FEE_TIER, fundedMakerRebateBps, makerRebateBpsFor, type OwnerFeeSchedule } from '../fee-schedule.js';
import { fillPayAmounts, fillReceivablesSurviveFees, ratesForFill as feeRatesForFill } from '../fees.js';
import { ocoLegParent, settlementOrderId } from '../oco-legs.js';
import { readOcoIntent } from '../oco-intent.js';
import { assertMarketOpen, assertSettlementRails, assertTradable } from '../risk.js';
import {
  HOLD_UNKNOWN_IN_FLIGHT_BOUND_SECONDS,
  classifyHoldPostError,
  orderHoldIdempotencyKey,
  type HoldRead,
  type HoldUnknownAlert,
  type HoldUnknownSweepResult,
} from '../hold-outcome.js';
import { toOrder, type OrderRow } from '../rows.js';
import { holdLeft } from '../order-holds.js';
import { type EngineSubmitRequest, type EngineSubmitResult } from '../matching-client.js';
import { attributionFromOrder, withLedgerAttribution } from '../auth-attribution.js';
import { buybackReleasePost, holdAccountOf, isBuybackUser } from '../buyback-order.js';
import { TradeError, type Market, type OrderRecord, type OrderStatus, type RecoveryReason } from '../types.js';
import type { PlaceOrderInput, TradeServiceInternal } from '../trade-service.js';

// ── Holds: the only two things that can happen to one ─────────────────────

/**
 * Unpublished owner schedule is a typed refuse — never listing-row 10/20.
 *
 * A spot market's own rates are resolved too, both roles at the regular tier, so a market whose pair group has no row
 * (or a row no granted recipe can post) refuses here, before any hold, rather than at its first fill. `at` is the
 * moment whose version is checked: placement checks now, then the order row's own `created_at`, which is the version
 * its fills are charged at. `tierId` is the fee tier the order is placed at, so a tier the market has no row for
 * refuses here too.
 */
export async function assertOwnerFeeSchedulePublished(
  svc: TradeServiceInternal,
  market: Pick<Market, 'kind' | 'symbol'>,
  at: Date = svc.now(),
  tierId: string = REGULAR_FEE_TIER,
): Promise<void> {
  const schedule = await svc.feeScheduleAt(at);
  if (schedule.published !== true) {
    throw new TradeError('published fee schedule is unavailable', 'trade.fee_schedule_blank');
  }
  if (market.kind !== 'spot') return;
  try {
    svc.ratesForSchedule(schedule, 0, 0, 'spot', market.symbol, tierId);
  } catch (err) {
    // The schedule's own message names its env key and the owner's internal group and tier ids; the caller gets the
    // code and a plain sentence.
    if (err instanceof TradeError) throw new TradeError('published fee schedule has no rate for this market', err.code);
    throw err;
  }
}

/**
 * Rates for one match. Each side is charged at the schedule version that was in force when ITS order was placed, and
 * at the fee tier it was placed at, so neither a version approved nor a tier snapshot taken after placement re-prices
 * an open order. The house market maker has no order
 * of its own to date: its side takes the taker's version.
 */
export async function ratesForFill(
  svc: TradeServiceInternal,
  makerDiscountBps: number,
  takerDiscountBps: number,
  kind: 'spot' | 'futures' | 'options',
  symbol: string | undefined,
  placedAt: { readonly maker: Date; readonly taker: Date },
  tiers: { readonly maker: string; readonly taker: string } = { maker: REGULAR_FEE_TIER, taker: REGULAR_FEE_TIER },
): Promise<{ makerFeeBps: number; takerFeeBps: number; makerRebateBps: number }> {
  const makerSchedule = await svc.feeScheduleAt(placedAt.maker);
  const takerSchedule = placedAt.maker.getTime() === placedAt.taker.getTime() ? makerSchedule : await svc.feeScheduleAt(placedAt.taker);
  const makerFeeBps = svc.ratesForSchedule(makerSchedule, makerDiscountBps, takerDiscountBps, kind, symbol, tiers.maker).makerFeeBps;
  const takerFeeBps = svc.ratesForSchedule(takerSchedule, makerDiscountBps, takerDiscountBps, kind, symbol, tiers.taker).takerFeeBps;
  // The maker's rebate is its own placement version's row at its own tier, funded by the taker rate this fill charges.
  const makerRebateBps =
    kind === 'spot' && symbol !== undefined
      ? fundedMakerRebateBps(makerRebateBpsFor(makerSchedule, { symbol, tierId: tiers.maker }), makerFeeBps, takerFeeBps)
      : 0;
  return { makerFeeBps, takerFeeBps, makerRebateBps };
}

export function ratesForSchedule(
  svc: TradeServiceInternal,
  schedule: OwnerFeeSchedule,
  makerDiscountBps: number,
  takerDiscountBps: number,
  kind: 'spot' | 'futures' | 'options',
  symbol?: string,
  tierId: string = REGULAR_FEE_TIER,
) {
  if (kind === 'options') {
    throw new TradeError('options fee schedule is unpublished', 'trade.fee_product_unpublished');
  }
  try {
    return feeRatesForFill(
      schedule,
      makerDiscountBps,
      takerDiscountBps,
      kind === 'futures' ? 'perpetual' : 'spot',
      symbol === undefined ? undefined : { symbol, tierId },
    );
  } catch (err) {
    if (err instanceof FeeScheduleError) {
      const code =
        err.code === 'trade.fee_product_unpublished' ||
        err.code === 'trade.rebate_recipe_unavailable' ||
        err.code === 'trade.min_fee_recipe_unavailable'
          ? err.code
          : 'trade.fee_schedule_blank';
      throw new TradeError(err.message, code);
    }
    throw err;
  }
}

/**
 * Refuse a match whose fees leave a side with nothing — BEFORE fill rows.
 *
 * `tradeFill` already throws `InvalidEntryError` for this class, but it runs
 * after the insert. Re-running then re-throws forever while `remainingHold`
 * treats the unposted fill as consumed. Checking here keeps the fills table
 * from outrunning the ledger when the post cannot heal.
 */
export function assertFillFeesPostable(
  svc: TradeServiceInternal,
  sequence: number,
  symbol: string,
  takerSide: 'buy' | 'sell',
  qty: Amount,
  quoteAmount: Amount,
  rates: { makerFeeBps: number; takerFeeBps: number },
): void {
  const pays = fillPayAmounts({ takerSide, qty, quoteAmount });
  if (
    fillReceivablesSurviveFees({
      ...pays,
      makerFeeBps: rates.makerFeeBps,
      takerFeeBps: rates.takerFeeBps,
    })
  ) {
    return;
  }
  throw new TradeError(
    `fill ${sequence} on ${symbol} would leave a side with nothing after fees ` +
      `(maker ${rates.makerFeeBps} bps / taker ${rates.takerFeeBps} bps) — refuse before recording the fill`,
    'trade.fee_exceeds_fill',
  );
}

/**
 * How much of an order's hold has NOT been spent by its fills or proven
 * native-amend qty-down releases.
 *
 * Derived, never stored as a running total. `hold_amount` is written once;
 * fills and `amend_released` are the only other inputs.
 */
/**
 * Local fill proof for operator reconcile. Empty `trade.fills` plus
 * `filled_qty = 0` is the only "no fill" this service can prove. A lost
 * engine fill is indistinguishable from never-filled until a fill row lands;
 * when rows exist (or filled_qty disagrees), we refuse to pick a money winner.
 */
export async function fillEvidence(svc: TradeServiceInternal, orderId: string): Promise<{ count: number; qty: Amount }> {
  const rows = await svc.sql<Array<{ count: string; qty: string }>>`
    SELECT COUNT(*)::text AS count, COALESCE(SUM(qty), 0)::text AS qty
      FROM trade.fills
     WHERE order_id = ${orderId}
  `;
  const countRaw = rows[0]?.count ?? '0';
  if (!/^[0-9]+$/.test(countRaw)) {
    throw new TradeError(`trade.fills count for ${orderId} is not an integer`, 'trade.reconcile_unknown_engine_miss');
  }
  return { count: Number(countRaw), qty: parseAmount(rows[0]?.qty ?? '0') };
}

export async function remainingHold(svc: TradeServiceInternal, sql: Sql, order: OrderRecord): Promise<Amount> {
  // A buy consumed quote, a sell consumed base. Expressed as a CASE over a
  // bound parameter rather than a dynamic column name: the two are the same
  // query plan, and this one cannot be turned into an injection by a future
  // edit that forgets where `side` came from.
  const rows = await sql<Array<{ consumed: string }>>`
    SELECT COALESCE(SUM(CASE WHEN ${order.side === 'buy'} THEN quote_amount ELSE qty END), 0) AS consumed
      FROM trade.fills WHERE order_id = ${order.id}
  `;
  const consumed = parseAmount(rows[0]?.consumed ?? '0');
  const remaining = holdLeft(order, consumed);

  if (remaining < 0n) {
    // The fills say this order spent more than it was funded for. That is not
    // a rounding question: either the engine matched an order it should not
    // have, or a fill was recorded twice. Refuse to guess — releasing a
    // negative would draw down whatever else this user has in `hold`, which
    // is another order's money.
    throw new TradeError(
      `order ${order.id} consumed ${formatAmount(consumed)} against a ${formatAmount(order.holdAmount)} hold`,
      'trade.hold_uncovered',
    );
  }

  return remaining;
}

/**
 * Move an order to a terminal state and give back what is left of its hold.
 *
 * THE RELEASE HAPPENS BEFORE THE STATUS CHANGE, and that ordering is the
 * answer to "if this crashes exactly here, whose funds are stranded?".
 * Terminal status is what makes this method return early, so setting it first
 * and crashing before the release would strand the remainder behind a row
 * that says there is nothing to do. This way a crash leaves a non-terminal
 * row, a retry recomputes the same remainder, and the ledger's
 * `order.release:<orderId>:0` key makes the second post a no-op.
 *
 * ONE RELEASE PER ORDER, EVER — sequence 0, fixed. An order reaches a
 * terminal state exactly once, so the key never needs to vary, and a fixed
 * key is what makes a double-release impossible rather than merely unlikely.
 * This is the bug the "partial fill then cancel" test exists to catch: the
 * remainder is `hold - Σ fills`, so the filled part is never released and the
 * unfilled part is never released twice.
 */
export async function finalize(
  svc: TradeServiceInternal,
  orderId: string,
  status: Extract<OrderStatus, 'cancelled' | 'filled' | 'expired' | 'rejected'>,
  reason?: string | null,
): Promise<void> {
  // An engine OCO leg is not an order row: it closes its parent, and only once no leg is left resting.
  if (ocoLegParent(orderId) !== null) {
    const parent = await svc.findOrder(settlementOrderId(orderId));
    if (parent) {
      await svc.finalizeOcoWhenNoLegLive(parent.marketId, orderId, reason, status === 'expired' ? 'expired' : 'cancelled');
    }
    return;
  }
  const outcome = await transaction(
    svc.sql,
    async (tx): Promise<{ order: OrderRecord; status: OrderStatus } | null> => {
      const rows = await tx<OrderRow[]>`SELECT * FROM trade.orders WHERE id = ${orderId} FOR UPDATE`;
      const row = rows[0];
      if (!row) return null;

      const order = toOrder(row);
      if (order.status !== 'open' && order.status !== 'pending' && order.status !== 'recovery_required') return null;

      const remaining = await svc.remainingHold(tx, order);
      // A qty-down orderHoldRelease can commit under its amend version before
      // amend_released does (a process death in that window). remainingHold
      // still counts that money and sequence 0 is a different key, so posting
      // `remaining` would pay it again. The pot is what can still come back;
      // when the pot is larger (a fill row the ledger has not drawn yet) keep
      // the derived remainder so that slice stays for tradeFill.
      // The amount under a given idempotency key must never change between
      // attempts: if a crashed attempt already booked sequence 0, the pot is
      // smaller now and re-capping would change the body. Reuse the key's
      // booked amount (post it again as a no-op); cap only a fresh release.
      // A buyback order's release is its own recipe and key (`buyback-order.ts`).
      const buyback = isBuybackUser(order.userId);
      const terminalKey = buyback ? buybackReleasePost(order, 1n).idempotencyKey : `order.release:${orderId}:0`;
      const booked = await svc.ledger.getTxByKey(terminalKey);
      let releasable: Amount;
      if (booked) {
        const credit = booked.entries.find((entry) => entry.direction === 'credit');
        releasable = credit ? credit.amount : 0n;
      } else {
        const bookHold = (await svc.ledger.balance(holdAccountOf(order))).amount;
        releasable = bookHold < remaining ? bookHold : remaining;
      }
      if (releasable > 0n) {
        // ── 6 · THE RELEASE ────────────────────────────────────────────────
        const release = buyback
          ? buybackReleasePost(order, releasable)
          : recipes.orderHoldRelease({
              orderId,
              userId: order.userId,
              assetId: order.holdAsset,
              amount: releasable,
              sequence: 0,
            });
        await svc.ledger.post(withLedgerAttribution(release, attributionFromOrder(order)));
      }

      const finalStatus: OrderStatus = order.filledQty > 0n && order.filledQty >= order.qty ? 'filled' : status;
      const reasonCode = reason && reason.length > 0 ? reason : null;
      await tx`
        UPDATE trade.orders
           SET status = ${finalStatus},
               reject_code = COALESCE(${reasonCode}, reject_code),
               updated_at = now()
         WHERE id = ${orderId}
      `;
      const kind =
        finalStatus === 'cancelled' ? 'cancel' : finalStatus === 'filled' ? 'fill' : finalStatus === 'expired' ? 'expire' : 'reject';
      await appendOrderEvent(tx, {
        orderId,
        parentId: parentIdFromClientOrder(order.clientOrderId),
        kind,
        quantity: formatAmount(order.qty),
        price: order.price === null ? null : formatAmount(order.price),
        code: kind === 'reject' ? (reasonCode ?? 'reject') : kind,
      });

      return { order, status: finalStatus };
    },
    { isolation: 'read committed', maxAttempts: 5 },
  );

  // Published outside the transaction. An XP award is not money and must not
  // be able to roll back a release, nor hold a database transaction open
  // across a broker round trip.
  if (outcome) {
    const latest = (await svc.findOrder(orderId)) ?? { ...outcome.order, status: outcome.status };
    await svc.publishOrderUpdated({ ...latest, status: outcome.status });
    // The buyback is the house, not a person: it earns no XP.
    if (outcome.order.filledQty > 0n && !isBuybackUser(outcome.order.userId)) await svc.publishXp(outcome.order, outcome.status);
  }
}

/**
 * Seconds still to wait before an absent `order.hold` key on this
 * `hold_unknown` row can no longer be in flight. 0 means a delete or cancel
 * is allowed. Read on the database clock. Does not write `updated_at`.
 */
export async function holdUnknownWaitSeconds(svc: TradeServiceInternal, orderId: string): Promise<number> {
  const rows = await svc.sql<Array<{ wait: string }>>`
    SELECT GREATEST(0, CEIL(${HOLD_UNKNOWN_IN_FLIGHT_BOUND_SECONDS}::numeric - EXTRACT(EPOCH FROM (now() - updated_at))))::text AS wait
      FROM trade.orders WHERE id = ${orderId} AND status = 'hold_unknown'
  `;
  return Number(rows[0]?.wait ?? 0);
}

/**
 * Absent-hold delete, only if the row is still past the in-flight bound.
 * Zero means a re-post touched `updated_at` after the wait read.
 */
export async function deleteAbsentHoldUnknownPastBound(svc: TradeServiceInternal, orderId: string): Promise<number> {
  const deleted = await svc.sql<Array<{ id: string }>>`
    DELETE FROM trade.orders
     WHERE id = ${orderId}
       AND status = 'hold_unknown'
       AND updated_at <= now() - make_interval(secs => ${HOLD_UNKNOWN_IN_FLIGHT_BOUND_SECONDS})
    RETURNING id
  `;
  return deleted.length;
}

/** Absent-hold cancel, with the same bound predicate as the delete. */
export async function cancelAbsentHoldUnknownPastBound(svc: TradeServiceInternal, orderId: string): Promise<number> {
  const cancelled = await svc.sql<Array<{ id: string }>>`
    UPDATE trade.orders SET status = 'cancelled', updated_at = now()
     WHERE id = ${orderId}
       AND status = 'hold_unknown'
       AND updated_at <= now() - make_interval(secs => ${HOLD_UNKNOWN_IN_FLIGHT_BOUND_SECONDS})
    RETURNING id
  `;
  return cancelled.length;
}

/** True when a taker row is older than the cap on the database clock. */
export async function takerOlderThanCap(svc: TradeServiceInternal, orderId: string): Promise<boolean> {
  const rows = await svc.sql<Array<{ age_ms: string }>>`
    SELECT (EXTRACT(EPOCH FROM (now() - created_at)) * 1000)::text AS age_ms
      FROM trade.orders WHERE id = ${orderId}
  `;
  return Number(rows[0]?.age_ms ?? '0') > svc.holdUnknownTakerMaxAgeMs;
}

/**
 * Why a booked `hold_unknown` order must not be submitted. Null means the
 * gates passed. Does not write the row.
 */
export async function holdUnknownSubmitRefusal(svc: TradeServiceInternal, order: OrderRecord, market: Market): Promise<string | null> {
  if (market.kind === 'spot' && !svc.spotEnabled) return 'spot trading is disabled';
  try {
    await svc.assertLifecycleAction(market, order.tif === 'PO' ? 'PLACE_POST_ONLY' : 'PLACE', order.type);
  } catch (err) {
    return err instanceof Error ? err.message : 'lifecycle gate refused';
  }
  if (market.status !== 'active') return `market status is ${market.status}`;
  if (svc.orderIsTaker(order) && (await svc.takerOlderThanCap(order.id))) {
    return `taker order is older than ${svc.holdUnknownTakerMaxAgeMs}ms`;
  }
  try {
    assertTradable(market, {
      futuresEnabled: svc.futuresEnabled,
      optionsSettlementLawStamped: svc.optionsSettlementAssetLaw.trim().length > 0,
      now: svc.now(),
    });
  } catch (err) {
    return err instanceof Error ? err.message : 'market is not tradable';
  }
  try {
    assertSettlementRails(market);
  } catch (err) {
    return err instanceof Error ? err.message : 'settlement rails refused';
  }
  try {
    assertMarketOpen(market, svc.now());
  } catch (err) {
    return err instanceof Error ? err.message : 'market is closed';
  }
  return null;
}

/** Claim the booked row and release the full hold. The engine never had it. */
export async function rejectBookedHoldUnknown(svc: TradeServiceInternal, order: OrderRecord, detail: string): Promise<OrderRecord> {
  const claimed = await svc.sql<Array<{ id: string }>>`
    UPDATE trade.orders SET status = 'open', updated_at = now()
     WHERE id = ${order.id} AND status = 'hold_unknown'
     RETURNING id
  `;
  if (claimed.length === 0) {
    const current = await svc.findOrder(order.id);
    if (current) return current;
    throw new TradeError(`order ${order.id} vanished during hold resolution`, 'trade.order_not_found');
  }
  await svc.finalize(order.id, 'rejected');
  svc.noteHoldUnknown({ orderId: order.id, resolution: 'booked', detail });
  const settled = await svc.findOrder(order.id);
  if (!settled) throw new TradeError(`order ${order.id} vanished during hold resolution`, 'trade.order_not_found');
  return settled;
}

export async function submitBookedHoldUnknown(svc: TradeServiceInternal, order: OrderRecord): Promise<OrderRecord> {
  if (!order.lifecycleProof) {
    svc.noteHoldUnknown({
      orderId: order.id,
      resolution: 'still_unknown',
      detail: 'hold is booked but the stored lifecycle proof is missing; not submitting',
    });
    throw new TradeError(`order ${order.id} hold is booked but cannot be submitted`, 'trade.hold_unknown');
  }
  const market = await svc.marketById(order.marketId);
  if (!market) throw new TradeError(`market ${order.marketId} not found`, 'trade.market_not_found');
  const refusal = await svc.holdUnknownSubmitRefusal(order, market);
  if (refusal) return svc.rejectBookedHoldUnknown(order, `booked hold was not submitted: ${refusal}`);
  // A stop-limit rests as a limit; its trigger lives in order_stop_trigger. Losing it here would
  // send the order to the book live, so the stored trigger rides every resubmit.
  const triggerRows = await svc.sql<Array<{ stop_price: string }>>`
    SELECT stop_price::text AS stop_price FROM trade.order_stop_trigger WHERE order_id = ${order.id}
  `;
  const storedTrigger = triggerRows[0]?.stop_price;
  // An OCO parent rests as its two legs; its row alone would resubmit as a plain limit.
  const ocoIntent = await readOcoIntent(svc.sql, order.id);
  const request = svc.toEngineRequest(
    order.id,
    order.userId,
    {
      marketId: order.marketId,
      side: order.side,
      type: order.type,
      qty: order.qty,
      price: order.price,
      tif: order.tif,
      clientOrderId: order.clientOrderId ?? undefined,
      subAccountId: order.subAccountId ?? undefined,
      ...(storedTrigger === undefined ? {} : { stopPx: parseAmount(storedTrigger) }),
      ...(ocoIntent ?? {}),
    } as PlaceOrderInput,
    order.type,
    order.tif,
    order.protectionPrice,
    order.lifecycleProof,
  );
  return svc.openAndSubmit(market, order.id, request);
}

/**
 * The same clientOrderId is retrying and the key is still absent inside the
 * bound. Re-post the identical hold. The sweep never calls this.
 */
export async function repostAbsentHold(svc: TradeServiceInternal, order: OrderRecord): Promise<OrderRecord> {
  const market = await svc.marketById(order.marketId);
  if (!market) throw new TradeError(`market ${order.marketId} not found`, 'trade.market_not_found');
  const refusal = await svc.holdUnknownSubmitRefusal(order, market);
  if (refusal || !order.lifecycleProof) {
    const why = refusal ?? 'the stored lifecycle proof is missing';
    svc.noteHoldUnknown({
      orderId: order.id,
      resolution: 'still_unknown',
      detail: `same-key retry refused to re-post order.hold: ${why}`,
    });
    throw new TradeError(`order ${order.id} hold outcome is unknown; ${why}`, 'trade.hold_unknown');
  }
  const touched = await svc.sql<Array<{ id: string }>>`
    UPDATE trade.orders SET updated_at = now()
     WHERE id = ${order.id} AND status = 'hold_unknown'
     RETURNING id
  `;
  if (touched.length === 0) {
    const current = await svc.findOrder(order.id);
    if (current) return current;
    throw new TradeError(`order ${order.id} vanished during hold resolution`, 'trade.order_not_found');
  }
  try {
    await svc.ledger.post(
      withLedgerAttribution(
        recipes.orderHold({
          orderId: order.id,
          userId: order.userId,
          assetId: order.holdAsset,
          amount: order.holdAmount,
        }),
        attributionFromOrder(order),
      ),
    );
  } catch (err) {
    const outcome = classifyHoldPostError(err);
    const wait = await svc.holdUnknownWaitSeconds(order.id);
    svc.noteHoldUnknown({
      orderId: order.id,
      resolution: 'still_unknown',
      detail:
        outcome === 'refused' || outcome === 'unsent'
          ? `same-key retry re-post of order.hold was refused before commit; row kept; wait ${wait}s`
          : `same-key retry re-post of order.hold did not answer; row kept; wait ${wait}s`,
    });
    throw new TradeError(
      `order ${order.id} hold outcome is unknown; wait ${wait} seconds before treating an absent hold as dead`,
      'trade.hold_unknown',
    );
  }
  return svc.submitBookedHoldUnknown(order);
}

export function noteHoldUnknown(svc: TradeServiceInternal, alert: HoldUnknownAlert): void {
  try {
    svc.onHoldUnknownAlert?.(alert);
  } catch {
    // The alert is a signal. A broken sink must not change the money decision.
  }
}

/** `null` from getTxByKey means the hold was not booked. A throw means we still do not know. */
export async function readHoldByKey(svc: TradeServiceInternal, orderId: string): Promise<HoldRead> {
  try {
    const tx = await svc.ledger.getTxByKey(orderHoldIdempotencyKey(orderId));
    return tx ? 'present' : 'absent';
  } catch {
    return 'unknown';
  }
}

/**
 * The hold is known to exist (the post returned, or getTxByKey found it).
 * Claim `open` once, then submit. A lost submit stays `recovery_required`
 * with the hold encumbered — that path is unchanged.
 */
export async function openAndSubmit(
  svc: TradeServiceInternal,
  market: Market,
  orderId: string,
  request: EngineSubmitRequest,
): Promise<OrderRecord> {
  const opened = await svc.sql<Array<{ id: string }>>`
    UPDATE trade.orders SET status = 'open', updated_at = now()
     WHERE id = ${orderId} AND status IN ('pending', 'hold_unknown')
     RETURNING id
  `;
  if (opened.length === 0) {
    const current = await svc.findOrder(orderId);
    if (current && current.status !== 'pending' && current.status !== 'hold_unknown') return current;
    throw new TradeError(`order ${orderId} vanished during hold resolution`, 'trade.order_not_found');
  }

  let result: EngineSubmitResult;
  try {
    result = await svc.matching.submit(market.id, request);
  } catch (err) {
    // INDETERMINATE. The request failed at the transport, so the engine may
    // or may not hold this order. Persist the frozen spine's
    // OUTCOME_UNKNOWN/SUBMIT_UNKNOWN evidence before returning the failure;
    // the hold stays encumbered and the retry fence now returns this row.
    await svc.markRecoveryRequired(orderId, 'SUBMIT_UNKNOWN');
    throw err;
  }

  await svc.applySubmitResult(market, orderId, result);
  const settled = await svc.findOrder(orderId);
  if (!settled) throw new TradeError(`order ${orderId} vanished during settlement`, 'trade.order_not_found');
  return settled;
}

/**
 * Same clientOrderId, or the sweep, with the row still `hold_unknown`.
 * Booked → submit, unless a gate refuses, in which case the hold is released.
 * Absent inside the in-flight bound stays. A retry may re-post that identical
 * hold; the sweep never does. Absent past the bound is deleted.
 */
export async function resumeHoldUnknown(svc: TradeServiceInternal, order: OrderRecord, source: 'retry' | 'sweep'): Promise<OrderRecord> {
  const read = await svc.readHoldByKey(order.id);
  if (read === 'unknown') {
    svc.noteHoldUnknown({
      orderId: order.id,
      resolution: 'still_unknown',
      detail: 'retry read of order.hold did not answer; row kept',
    });
    throw new TradeError(`order ${order.id} hold outcome is still unknown`, 'trade.hold_unknown');
  }
  if (read === 'absent') {
    const wait = await svc.holdUnknownWaitSeconds(order.id);
    if (wait > 0) {
      if (source === 'retry') return svc.repostAbsentHold(order);
      svc.noteHoldUnknown({
        orderId: order.id,
        resolution: 'still_unknown',
        detail: `order.hold read absent with ${wait}s of in-flight wait left; row kept`,
      });
      throw new TradeError(
        `order ${order.id} hold outcome is unknown; wait ${wait} seconds before treating an absent hold as dead`,
        'trade.hold_unknown',
      );
    }
    const deleted = await svc.deleteAbsentHoldUnknownPastBound(order.id);
    if (deleted === 0) {
      const current = await svc.findOrder(order.id);
      if (current?.status === 'hold_unknown') {
        const wait = await svc.holdUnknownWaitSeconds(order.id);
        svc.noteHoldUnknown({
          orderId: order.id,
          resolution: 'still_unknown',
          detail: `absent delete matched no row; ${wait}s of in-flight wait left`,
        });
        throw new TradeError(
          `order ${order.id} hold outcome is unknown; wait ${wait} seconds before treating an absent hold as dead`,
          'trade.hold_unknown',
        );
      }
      if (current) return current;
    }
    throw new TradeError(`order ${order.id} hold was not booked`, 'trade.hold_not_booked');
  }
  return svc.submitBookedHoldUnknown(order);
}

/**
 * Orders stuck in `hold_unknown`. Each one is read by its own
 * `order.hold:<orderId>` key. A booked hold is submitted, or released when a
 * gate refuses. An absent hold inside the in-flight bound is kept. An absent
 * hold past the bound is deleted with no release. A failed read leaves the
 * row and alerts. This pass never re-posts.
 */
export async function sweepHoldUnknown(svc: TradeServiceInternal, limit: number): Promise<HoldUnknownSweepResult> {
  const capped = Math.min(Math.max(Math.floor(limit), 1), 100);
  const rows = await svc.sql<Array<{ id: string }>>`
    SELECT id FROM trade.orders
     WHERE status = 'hold_unknown'
     ORDER BY created_at ASC
     LIMIT ${capped}
  `;
  const booked: string[] = [];
  const absent: string[] = [];
  const stillUnknown: string[] = [];
  const alerts: HoldUnknownAlert[] = [];
  const alert = (item: HoldUnknownAlert) => {
    alerts.push(item);
    svc.noteHoldUnknown(item);
  };

  for (const row of rows) {
    const order = await svc.findOrder(row.id);
    if (!order || order.status !== 'hold_unknown') continue;
    const read = await svc.readHoldByKey(order.id);
    if (read === 'unknown') {
      stillUnknown.push(order.id);
      alert({
        orderId: order.id,
        resolution: 'still_unknown',
        detail: 'sweep could not read order.hold; row kept',
      });
      continue;
    }
    if (read === 'absent') {
      const wait = await svc.holdUnknownWaitSeconds(order.id);
      if (wait > 0) {
        stillUnknown.push(order.id);
        alert({
          orderId: order.id,
          resolution: 'still_unknown',
          detail: `sweep read order.hold as absent with ${wait}s of in-flight wait left; row kept`,
        });
        continue;
      }
      const deleted = await svc.deleteAbsentHoldUnknownPastBound(order.id);
      if (deleted > 0) {
        absent.push(order.id);
        alert({
          orderId: order.id,
          resolution: 'absent',
          detail: 'sweep read order.hold as absent past the in-flight bound; unfunded intent deleted, no release posted',
        });
      } else {
        const current = await svc.findOrder(order.id);
        if (current?.status === 'hold_unknown') {
          stillUnknown.push(order.id);
          alert({
            orderId: order.id,
            resolution: 'still_unknown',
            detail: 'sweep delete matched no row; a re-post touched the row inside the in-flight bound',
          });
        }
      }
      continue;
    }
    try {
      const settled = await svc.resumeHoldUnknown(order, 'sweep');
      booked.push(order.id);
      alert({
        orderId: order.id,
        resolution: 'booked',
        detail:
          settled.status === 'rejected'
            ? `sweep found the hold and refused to submit; status=${settled.status}`
            : 'sweep found the hold and submitted the order',
      });
    } catch (err) {
      const current = await svc.findOrder(order.id);
      if (!current) {
        absent.push(order.id);
        alert({
          orderId: order.id,
          resolution: 'absent',
          detail: 'sweep removed the unfunded intent while resolving the hold',
        });
        continue;
      }
      if (current.status !== 'hold_unknown') {
        booked.push(order.id);
        alert({
          orderId: order.id,
          resolution: 'booked',
          detail: `sweep found the hold; submit ended status=${current.status}`,
        });
      } else {
        stillUnknown.push(order.id);
        alert({
          orderId: order.id,
          resolution: 'still_unknown',
          detail: err instanceof Error ? err.message : 'sweep could not open the booked hold',
        });
      }
    }
  }

  return { examined: rows.length, booked, absent, stillUnknown, alerts };
}

/**
 * Persist an unresolved command without touching the ledger. The
 * reconciliation key is deterministic per order/reason, so restart/replay
 * and client retries all converge on one recovery case.
 */
export async function markRecoveryRequired(svc: TradeServiceInternal, orderId: string, reason: RecoveryReason): Promise<void> {
  const reconciliationKey = `trade.order.reconcile:${orderId}:${reason}`;
  await svc.sql`
    UPDATE trade.orders
       SET status = 'recovery_required',
           recovery_reason = ${reason},
           reconciliation_key = ${reconciliationKey},
           updated_at = now()
     WHERE id = ${orderId}
       AND status IN ('pending', 'open', 'recovery_required')
  `;
}

/** Close out an order that filled completely — no cancellation is emitted for one. */
export async function finalizeIfComplete(svc: TradeServiceInternal, orderId: string): Promise<void> {
  const order = await svc.findOrder(orderId);
  if (!order) return;
  if (order.status !== 'open' && order.status !== 'pending' && order.status !== 'recovery_required') return;
  if (order.filledQty < order.qty) return;
  await svc.finalize(orderId, 'filled');
}
