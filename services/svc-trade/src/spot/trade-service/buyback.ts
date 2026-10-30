/**
 * The token buyback's IOC limit buy (`../buyback-order.ts`), placed for svc-token through `../buyback-door.ts`.
 *
 * The same spine as a customer order (§5.2): the gates, the intent row, the hold, the engine, then the fills and the
 * release on the existing settlement path. What differs is whose money it is: the hold is the rewards engine's own
 * (`buybackOrderHold`), and the engine sees the house STP account `house:buyback`.
 *
 * If this crashes exactly here, whose funds are stranded? Nobody's, and none are a customer's:
 *   · after the row, before the hold: a `pending` row with nothing held, which reconcile deletes after the in-flight
 *     bound;
 *   · after the hold, before the engine: the swept quote sits in the rewards engine's own hold for this order, and
 *     reconcile releases it through `finalize`. Until then a retry under the same run id answers
 *     `trade.buyback_in_flight`; it never resubmits;
 *   · after the engine: fills settle on the submit result or on the fill events, and the IOC remainder is released.
 */
import { buybackOrderHoldAccount, formatAmount, parseAmount, recipes, type Amount } from '@intafaced/ledger-client';
import { classifyHoldPostError } from '../hold-outcome.js';
import { orderIdFor } from '../ids.js';
import { REGULAR_FEE_TIER } from '../fee-schedule.js';
import { assertMarketOpen, assertNotional, assertPrice, assertQty, assertSettlementRails, assertTradable, holdFor } from '../risk.js';
import { withLedgerAttribution } from '../auth-attribution.js';
import {
  BUYBACK_BOOK_UNREADABLE,
  BUYBACK_CONFLICT,
  BUYBACK_HOUSE_MAKER,
  BUYBACK_IN_FLIGHT,
  BUYBACK_INVALID,
  BUYBACK_MATCHING_ACCOUNT_ID,
  HOUSE_BUYBACK_USER_UUID,
  buybackAttribution,
} from '../buyback-order.js';
import { MM_MATCHING_ACCOUNT_ID } from '../../mm/fill-account.js';
import { type EngineSubmitRequest } from '../matching-client.js';
import { TradeError, type OrderRecord } from '../types.js';
import type { TradeServiceInternal } from '../trade-service.js';

export interface BuybackIocBuyInput {
  readonly symbol: string;
  /** Base quantity to buy, on the lot grid. */
  readonly qty: Amount;
  /** The worst price the buy may pay, on the tick grid. The hold is `ceil(price × qty)`. */
  readonly price: Amount;
  /** svc-token's run id. The order id derives from it, so a retry finds the first order. */
  readonly clientOrderId: string;
}

export interface BuybackIocBuyResult {
  readonly orderId: string;
  readonly status: OrderRecord['status'];
  readonly filledQty: Amount;
  /** Quote reserved from the rewards engine for this order. */
  readonly held: Amount;
  /** Quote the fills took from the hold. */
  readonly spent: Amount;
}

const TERMINAL = new Set<OrderRecord['status']>(['filled', 'cancelled', 'rejected', 'expired']);

async function resultOf(svc: TradeServiceInternal, order: OrderRecord): Promise<BuybackIocBuyResult> {
  const rows = await svc.sql<Array<{ spent: string }>>`
    SELECT COALESCE(SUM(quote_amount), 0)::text AS spent FROM trade.fills WHERE order_id = ${order.id}
  `;
  return {
    orderId: order.id,
    status: order.status,
    filledQty: order.filledQty,
    held: order.holdAmount,
    spent: parseAmount(rows[0]?.spent ?? '0'),
  };
}

export async function placeBuybackIocBuy(svc: TradeServiceInternal, input: BuybackIocBuyInput): Promise<BuybackIocBuyResult> {
  const clientOrderId = input.clientOrderId;
  if (
    typeof clientOrderId !== 'string' ||
    clientOrderId.length < 1 ||
    clientOrderId.length > 64 ||
    clientOrderId.trim() !== clientOrderId
  ) {
    throw new TradeError('the buyback run id is required (1–64 chars, no surrounding spaces)', BUYBACK_INVALID);
  }
  const market = await svc.marketBySymbol(input.symbol);
  if (!market) throw new TradeError(`market ${input.symbol} not found`, 'trade.market_not_found');
  if (market.kind !== 'spot' || market.paper) {
    throw new TradeError(`the token buyback buys on a live spot book; ${market.symbol} is not one`, BUYBACK_INVALID);
  }

  const orderId = orderIdFor(HOUSE_BUYBACK_USER_UUID, market.id, clientOrderId);
  // Retry identity first, as on a customer order: a retry must find the original even after a halt.
  const existing = await svc.findOrder(orderId);
  if (existing) {
    if (existing.side !== 'buy' || existing.tif !== 'IOC' || existing.qty !== input.qty || existing.price !== input.price) {
      throw new TradeError(`buyback run ${clientOrderId} was already placed with another command`, BUYBACK_CONFLICT);
    }
    if (!TERMINAL.has(existing.status)) {
      throw new TradeError(`buyback run ${clientOrderId} is still settling (${existing.status})`, BUYBACK_IN_FLIGHT);
    }
    return resultOf(svc, existing);
  }

  // ── 2 · RISK CHECKS, before anything is held ──────────────────────────────
  if (!svc.spotEnabled) throw new TradeError('spot trading is disabled by the operator kill-switch', 'trade.spot_disabled');
  const lifecycleProof = await svc.assertLifecycleAction(market, 'PLACE', 'limit');
  assertTradable(market, { futuresEnabled: svc.futuresEnabled, now: svc.now() });
  assertSettlementRails(market);
  assertMarketOpen(market, svc.now());
  assertQty(market, input.qty);
  assertPrice(market, input.price);
  assertNotional(market, input.price, input.qty);
  await svc.refuseRestartedEngineSequence(market);
  // A blank fee schedule refuses here, before the hold, not at the first fill.
  await svc.assertOwnerFeeSchedulePublished(market, undefined, REGULAR_FEE_TIER);

  // House against house is wash volume. The engine's STP only knows one account at a time, so a resting house
  // market-maker ask this buy would cross is refused here, before the hold; the fill path refuses one that appears in
  // between (`settleBuybackFill`).
  let live: Awaited<ReturnType<TradeServiceInternal['matching']['listOrders']>>;
  try {
    live = await svc.matching.listOrders(market.id);
  } catch (err) {
    throw new TradeError(`the ${market.symbol} book could not be read for house asks: ${(err as Error).message}`, BUYBACK_BOOK_UNREADABLE);
  }
  const houseAsk = live.orders.find(
    (o) => o.accountId === MM_MATCHING_ACCOUNT_ID && o.side === 'sell' && parseAmount(o.price) <= input.price,
  );
  if (houseAsk) {
    throw new TradeError(
      `the buyback would cross the house market maker's ask ${houseAsk.orderId} at ${houseAsk.price} on ${market.symbol}; house against house is refused`,
      BUYBACK_HOUSE_MAKER,
    );
  }

  const hold = holdFor(market, 'buy', input.price, input.qty);
  const attribution = buybackAttribution();

  // ── 2b · THE INTENT ROW, before the hold, so the hold is never the orphan ─
  const inserted = await svc.sql<Array<{ id: string }>>`
    INSERT INTO trade.orders (
      id, user_id, market_id, client_order_id, side, type, price, qty, status, tif,
      hold_asset, hold_amount, fee_discount_bps, fee_tier, tier_volume, seeded, lifecycle_proof, session_id, api_key_id
    ) VALUES (
      ${orderId}, ${HOUSE_BUYBACK_USER_UUID}, ${market.id}, ${clientOrderId}, 'buy', 'limit',
      ${formatAmount(input.price)}::numeric, ${formatAmount(input.qty)}::numeric, 'pending', 'IOC',
      ${hold.assetId}, ${formatAmount(hold.amount)}::numeric, ${0}, ${REGULAR_FEE_TIER}, ${false}, ${false},
      ${JSON.stringify(lifecycleProof)}::text::jsonb, ${attribution.sessionId}, ${attribution.apiKeyId}
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `;
  if (inserted.length === 0) {
    throw new TradeError(`buyback run ${clientOrderId} is being placed by another call`, BUYBACK_IN_FLIGHT);
  }

  // ── 3 · THE HOLD: rewards engine → this order's house hold ────────────────
  const holdPost = recipes.buybackOrderHold({ orderId, quoteAsset: hold.assetId, amount: hold.amount });
  try {
    await svc.ledger.post(withLedgerAttribution(holdPost, attribution));
  } catch (err) {
    const outcome = classifyHoldPostError(err);
    if (outcome === 'refused' || outcome === 'unsent') {
      // The ledger named a refusal, or the socket never connected: nothing committed, so the intent row goes.
      await svc.sql`DELETE FROM trade.orders WHERE id = ${orderId} AND status = 'pending'`;
      throw err;
    }
    // Unknown: a timeout can land after the hold is booked. The row stays `pending` and is never deleted here;
    // reconcile reads the hold account after the in-flight bound and deletes or releases from what it finds.
    let read: 'present' | 'absent' | 'unknown';
    try {
      read = (await svc.ledger.getTxByKey(holdPost.idempotencyKey)) ? 'present' : 'absent';
    } catch {
      read = 'unknown';
    }
    if (read !== 'present') {
      throw new TradeError(`buyback run ${clientOrderId} hold outcome is unknown; the order is kept for reconcile`, 'trade.hold_unknown');
    }
  }
  // The engine is only asked once the book holds exactly what this row says it holds.
  const heldNow = (await svc.ledger.balance(buybackOrderHoldAccount(hold.assetId, orderId))).amount;
  if (heldNow !== hold.amount) {
    await svc.markRecoveryRequired(orderId, 'RECONCILIATION_REQUIRED');
    throw new TradeError(
      `buyback run ${clientOrderId} holds ${formatAmount(heldNow)} ${hold.assetId}, not the ${formatAmount(hold.amount)} its row names`,
      BUYBACK_CONFLICT,
    );
  }

  const request: EngineSubmitRequest = {
    orderId,
    accountId: BUYBACK_MATCHING_ACCOUNT_ID,
    type: 'limit',
    side: 'buy',
    qty: formatAmount(input.qty),
    price: formatAmount(input.price),
    tif: 'IOC',
    lifecycleProof,
  };
  let settled: OrderRecord;
  try {
    settled = await svc.openAndSubmit(market, orderId, request);
  } catch (err) {
    // The engine matched a house market-maker order that appeared after the pre-check, and settlement refused it. The
    // engine and this row now disagree; the quote stays in the rewards engine's own hold and the base in the house
    // maker's, so no customer's funds are touched. The row is marked `recovery_required` and never settled or released
    // here: reconcile releases the hold only once the engine and `trade.fills` prove nothing else filled, and otherwise
    // leaves it as a named break.
    if (err instanceof TradeError && err.code === BUYBACK_HOUSE_MAKER) await svc.markRecoveryRequired(orderId, 'RECONCILIATION_REQUIRED');
    throw err;
  }
  return resultOf(svc, settled);
}
