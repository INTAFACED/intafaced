import { MemorySeenStore, idempotent, type EventBus, type SeenStore, type Subscription } from '@intafaced/events';
import type { TradeService } from './spot/trade-service.js';
import './spot/qty-up-amend.js';
import './spot/gtd-gtt-place.js';
import './spot/reduce-only-place.js';
import './spot/post-only-place.js';
import './spot/ioc-place.js';
import './spot/fok-place.js';
import './spot/iceberg-place.js';
import './spot/stop-limit-place.js';
import './spot/trailing-stop-place.js';
import './spot/option-place.js';
import './spot/min-qty-place.js';
import './spot/aon-place.js';
import './spot/peg-place.js';
import './spot/auction-place.js';
import './spot/oco-place.js';
import './spot/market-halt-place.js';
import './spot/venue-halt-place.js';
import './spot/market-reduce-only-place.js';
import './spot/market-post-only-place.js';
import './spot/market-prelaunch-place.js';
import './spot/market-expired-place.js';
import './spot/market-delisted-place.js';
import { bindCloseSpotTrade } from './spot/close-position.js';

/**
 * EVENT WIRING (§10, §5.2 step 3).
 *
 * svc-matching publishes every match and every departure from the book to
 * `intafaced.matching.*` whether or not the submitting request survived. These
 * consumers are the recovery path for exactly that case: a process that died
 * between the engine printing a fill and this service settling it heals when
 * the event is delivered.
 *
 * Both handlers are idempotent twice over — `idempotent()` here, and business
 * keys underneath (`trade.fill:<market>:<sequence>` at the ledger, a unique
 * index on the fills table, and a fixed release key per order). That is
 * deliberate belt and braces: at-least-once is the only delivery there is, and
 * a redelivered fill that settled twice would pay a counterparty out of a hold
 * that only funded one trade.
 *
 * This service publishes NO subject of its own. `intafaced.trade.*` does not
 * exist in `packages/events/src/catalog.ts`, and adding one is a contracts PR
 * that comes first (§15.2) — so the only thing emitted from here is
 * `intafaced.identity.xp.earned`, which the catalog already declares and which
 * §5.2 asks for per filled order.
 */
/**
 * The futures side of the same two subjects (futures ADR slice 6). A fill between two matched futures orders goes
 * here; any other fill, including one on a futures market between orders the spot path placed, goes to the spot
 * path. The route is the orders, not the market, the same way cancels are routed. `current` is null until
 * PositionService is built.
 */
export interface MatchedFillsSink {
  /** True when both orders are matched futures orders, false when neither is. A fill between one of each refuses. */
  ownsFill(fill: { makerOrderId: string; takerOrderId: string }): Promise<boolean>;
  settle(fill: {
    marketId: string;
    makerOrderId: string;
    takerOrderId: string;
    price: string;
    qty: string;
    sequence: number;
  }): Promise<void>;
  /** `remainingQty` is what left the book unfilled; fills the engine printed before it may still be on their way. */
  releaseCancelled(orderId: string, remainingQty: string): Promise<boolean>;
}

export async function subscribeMatchingEvents(
  bus: EventBus,
  trade: TradeService,
  store: SeenStore = new MemorySeenStore(),
  futures: { current: MatchedFillsSink | null } = { current: null },
): Promise<Subscription[]> {
  bindCloseSpotTrade(trade);
  const filled = await bus.subscribe(
    'orderFilled',
    idempotent(
      async (payload) => {
        const sink = futures.current;
        if (sink && (await sink.ownsFill(payload))) {
          await sink.settle({
            marketId: payload.marketId,
            makerOrderId: payload.makerOrderId,
            takerOrderId: payload.takerOrderId,
            price: payload.price,
            qty: payload.qty,
            sequence: payload.sequence,
          });
          return;
        }
        await trade.settleFillEvent({
          marketId: payload.marketId,
          makerOrderId: payload.makerOrderId,
          takerOrderId: payload.takerOrderId,
          price: payload.price,
          qty: payload.qty,
          sequence: payload.sequence,
          makerAccountId: payload.makerAccountId,
          takerAccountId: payload.takerAccountId,
        });
      },
      store,
      'svc-trade',
    ),
    { durable: 'trade-fills' },
  );

  const cancelled = await bus.subscribe(
    'orderCancelled',
    idempotent(
      async (payload) => {
        if (futures.current && (await futures.current.releaseCancelled(payload.orderId, payload.remainingQty))) return;
        await trade.releaseOnCancelEvent(payload.orderId, payload.remainingQty, payload.reason);
      },
      store,
      'svc-trade',
    ),
    { durable: 'trade-cancels' },
  );

  return [filled, cancelled];
}
