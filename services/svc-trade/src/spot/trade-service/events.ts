/**
 * Events: XP and order-updated publishing, fill events and cancel releases.
 *
 * Moved out of `trade-service.ts` as it was (owner decision 2026-10-23): `TradeService` keeps one method per
 * function here, which passes itself as `svc`.
 */
import type { EventBus } from '@intafaced/events';
import { formatAmount, parseAmount, sub, type Amount } from '@intafaced/ledger-client';
import { withMoneySpan } from '../../tracing.js';
import { ocoLegParent, settlementOrderId } from '../oco-legs.js';
import { recoverMatchingAccountId } from '../../mm/fill-account.js';
import { TradeError, type OrderRecord, type OrderStatus } from '../types.js';
import type { TradeServiceInternal } from '../trade-service.js';

/** `TradeService` as the functions here that publish see it: they publish on its `@intafaced/events` bus. */
type PublishingService = TradeServiceInternal & { readonly bus: EventBus };

// ── Events ────────────────────────────────────────────────────────────────

/**
 * §5.2 step 4: "XP event emitted per filled order."
 *
 * Emitted once, at the terminal transition, keyed on the order id so a
 * redelivery cannot pay the same achievement twice. svc-identity is the only
 * writer of rank state (§4.1) — this service says what happened and has no
 * opinion about what it is worth.
 *
 * SOCKET §13 — volume-weighted XP and rolling fee tiers. §5.2 also asks for
 * "volume aggregates per user per window [to] feed rank + fee-tier". That is
 * a windowed aggregation job over `fills`, which needs a window table and a
 * schedule of its own; the fills it would read are all written here already.
 */
export async function publishXp(svc: PublishingService, order: OrderRecord, status: OrderStatus): Promise<void> {
  await svc.bus.publish(
    'xpEarned',
    {
      userId: order.userId,
      sourceModule: 'trade',
      action: status === 'filled' ? 'order.filled' : 'order.partially_filled',
      xpDelta: status === 'filled' ? 10 : 5,
      meta: { orderId: order.id, marketId: order.marketId },
    },
    { idempotencyKey: `trade.order.xp:${order.id}` },
  );
}

/**
 * Private order stream feed. Not a money path — the ledger already moved.
 * Keyed on (order, status, filledQty) so redelivery of the same snapshot is
 * a bus no-op while a fill that advances filledQty still ships.
 */
export async function publishOrderUpdated(svc: PublishingService, order: OrderRecord): Promise<void> {
  // The v1 event catalog predates RECOVERY_REQUIRED. Never downgrade this
  // state to OPEN/REJECTED on the bus; REST projections carry the additive
  // recovery evidence until the catalog version is extended.
  if (order.status === 'recovery_required' || order.status === 'hold_unknown') return;
  await svc.bus.publish(
    'orderUpdated',
    {
      orderId: order.id,
      userId: order.userId,
      marketId: order.marketId,
      status: order.status,
      side: order.side,
      type: order.type,
      qty: formatAmount(order.qty),
      filledQty: formatAmount(order.filledQty),
      price: order.price == null ? null : formatAmount(order.price),
      clientOrderId: order.clientOrderId,
      ts: new Date().toISOString(),
    },
    { idempotencyKey: `trade.order.updated:${order.id}:${order.status}:${formatAmount(order.filledQty)}` },
  );
}

/**
 * Settle a fill that arrived as an event rather than in a submit response.
 *
 * The recovery path. svc-matching publishes every match to
 * `intafaced.matching.order.filled` regardless of who submitted it, so a
 * process that died between the engine printing a fill and this service
 * settling it heals when the event is delivered. Every step is keyed on
 * (market, engine sequence), so this and the inline path cannot double-settle
 * each other.
 *
 * `makerAccountId` / `takerAccountId` come from the matching event when the
 * catalog carries them. House MM seed makers are matching STP
 * `house:market-maker`. A recorded seed row uses HOUSE_MM_USER_UUID for
 * bookkeeping — recovery rewrites that to the house STP id so the fill
 * cannot look like an anonymous customer. Empty event + no house row must
 * not invent house MM. User makers fall back to the order row's userId.
 */
export async function settleFillEvent(
  svc: TradeServiceInternal,
  input: {
    marketId: string;
    makerOrderId: string;
    takerOrderId: string;
    price: string;
    qty: string;
    sequence: number;
    /** Matching STP account for the maker leg — required for house MM recovery. */
    makerAccountId?: string;
    /** Matching STP account for the taker leg (users: userId). */
    takerAccountId?: string;
  },
): Promise<void> {
  const market = await svc.marketById(input.marketId);
  if (!market) throw new TradeError(`market ${input.marketId} not found`, 'trade.market_not_found');

  const taker = await svc.findOrder(settlementOrderId(input.takerOrderId));
  if (!taker) throw new TradeError(`order ${input.takerOrderId} not found`, 'trade.order_not_found');

  // Prefer event payload; then orders table. House bookkeeping UUID → house STP id.
  // Never invent house MM from an unknown maker (empty + no house row).
  const makerRow = await svc.findOrder(settlementOrderId(input.makerOrderId));
  const makerAccountId = recoverMatchingAccountId({
    eventAccountId: input.makerAccountId,
    orderUserId: makerRow?.userId,
  });
  const takerAccountId = recoverMatchingAccountId({
    eventAccountId: input.takerAccountId,
    orderUserId: taker.userId,
  });

  await withMoneySpan(
    'trade.settleFillEvent',
    { operation: 'settle_fill', marketId: input.marketId, symbol: market.symbol, qty: input.qty },
    async () => {
      await svc.settleFill(market, {
        sequence: input.sequence,
        makerOrderId: input.makerOrderId,
        makerAccountId,
        takerOrderId: input.takerOrderId,
        takerAccountId,
        takerSide: taker.side,
        price: input.price,
        qty: input.qty,
      });
      await svc.finalizeIfComplete(settlementOrderId(input.makerOrderId));
      await svc.finalizeIfComplete(settlementOrderId(input.takerOrderId));
    },
  );
}

/**
 * Release the hold for an order the engine says has left the book.
 *
 * The other half of the recovery path. Idempotent: `finalize` returns
 * immediately for an order already in a terminal state, and the release key
 * is fixed per order, so a redelivered `order.cancelled` cannot release
 * twice. The engine's reason rides along, as the inline outcome records
 * it: an order the engine expired (a GTD/GTT at its expiry) ends `expired`,
 * and a self-trade pull keeps its reason. Whichever path comes first decides
 * the row, so both must write the same.
 */
export async function releaseOnCancelEvent(
  svc: TradeServiceInternal,
  orderId: string,
  remainingQty: string,
  reason?: string,
): Promise<void> {
  await withMoneySpan('trade.releaseOnCancelEvent', { operation: 'release_hold', orderId }, async () => {
    // A bare cancel event for an OCO leg never releases the shared hold: the fill that caused it (a full leg
    // fill cancels the sibling) may still be unsettled, and the release would hand back money that fill spends.
    // The inline outcome settles fills before cancellations and closes the parent; the hold stays until then.
    if (ocoLegParent(orderId) !== null) return;
    // The engine's own word on what it took off the book wins over a cancel's 0 for an order it no longer had.
    await svc.sql`UPDATE trade.orders SET engine_left_qty = ${remainingQty}::numeric WHERE id = ${orderId}`;
    await svc.refuseCancelAheadOfFill(orderId, parseAmount(remainingQty));
    // A person's own cancel ('requested') is not an engine reason: its inline path writes none, so neither does this.
    const engineReason = reason === 'requested' ? undefined : reason;
    await svc.finalize(orderId, engineReason === 'expired' ? 'expired' : 'cancelled', engineReason);
  });
}

/**
 * The same race for an ordinary order. An IOC that partly fills produces a fill event and a cancel event
 * for its remainder at the same moment, on two consumers. If the cancel is handled first, `finalize`
 * finds no fill row, releases the whole hold, and the fill's `tradeFill` then fails on an empty hold:
 * the engine matched, the money never moved, and the counterparty's order stays open with its hold.
 * The engine says how much filled (`qty - remainingQty`); until `trade.fills` shows at least that, refuse,
 * so the hold stays and the bus redelivers the cancel after the fill settles.
 *
 * If the fill never settles inside the redelivery budget, the cancel is abandoned and the hold stays with
 * the order: money stays where it can be found rather than going back while a fill is owed. A submission
 * also finalizes its own IOC, market and self-trade remainders inline after its fills, so this consumer is
 * the recovery path, not the normal one. A house market-maker stub row (qty is its first fill, not the
 * engine size) and an amend that has not committed yet read as "nothing more filled"; both behave as before.
 */
export async function refuseCancelAheadOfFill(svc: TradeServiceInternal, orderId: string, remainingQty: Amount): Promise<void> {
  const order = await svc.findOrder(orderId);
  // The same statuses `finalize` acts on; any other is terminal and a no-op there.
  if (!order || (order.status !== 'open' && order.status !== 'pending' && order.status !== 'recovery_required')) return;
  const engineFilled = sub(order.qty, remainingQty);
  if (engineFilled <= 0n) return;
  const recorded = (await svc.fillEvidence(orderId)).qty;
  if (recorded >= engineFilled) return;
  throw new TradeError(
    `order ${orderId}: the engine filled ${formatAmount(engineFilled)} but ${formatAmount(recorded)} is settled; the cancel waits for the fill`,
    'trade.cancel_ahead_of_fill',
    { engineFilled: formatAmount(engineFilled), settled: formatAmount(recorded) },
  );
}
