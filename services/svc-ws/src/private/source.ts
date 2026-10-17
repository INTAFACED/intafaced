import type { EventBus, Subscription } from '@intafaced/events';
import type { HubLogger } from '../depth/hub.js';
import type { PrivateOrderHub } from './hub.js';
import type { PositionsStream } from './positions-stream.js';

/**
 * Bus → private hub.
 *
 * Consumes trade-owned private signals. Failures are redelivered by JetStream;
 * these handlers are pure fan-out (no money path).
 */
export async function subscribePrivateOrders(input: {
  bus: EventBus;
  hub: PrivateOrderHub;
  durable: string;
  log?: HubLogger;
}): Promise<Subscription> {
  const { bus, hub, durable, log } = input;

  return bus
    .subscribe(
      'orderUpdated',
      (payload) => {
        hub.publish({
          orderId: payload.orderId,
          userId: payload.userId,
          marketId: payload.marketId,
          status: payload.status,
          side: payload.side,
          type: payload.type,
          qty: payload.qty,
          filledQty: payload.filledQty,
          price: payload.price,
          clientOrderId: payload.clientOrderId,
          ts: payload.ts,
        });
      },
      { durable },
    )
    .then((sub) => {
      log?.info({ durable, subject: 'orderUpdated' }, 'ws: private orders subscribed');
      return sub;
    });
}

export async function subscribePrivateFills(input: {
  bus: EventBus;
  hub: PrivateOrderHub;
  durable: string;
  log?: HubLogger;
}): Promise<Subscription> {
  const { bus, hub, durable, log } = input;

  return bus
    .subscribe(
      'fillSettled',
      (payload) => {
        hub.publishFill({
          fillId: payload.fillId,
          orderId: payload.orderId,
          userId: payload.userId,
          marketId: payload.marketId,
          side: payload.side,
          liquidity: payload.liquidity,
          price: payload.price,
          qty: payload.qty,
          quoteAmount: payload.quoteAmount,
          feeAsset: payload.feeAsset,
          feeAmount: payload.feeAmount,
          feeBps: payload.feeBps,
          sequence: payload.sequence,
          ts: payload.ts,
        });
      },
      { durable },
    )
    .then((sub) => {
      log?.info({ durable, subject: 'fillSettled' }, 'ws: private fills subscribed');
      return sub;
    });
}

export async function subscribePrivatePositions(input: {
  bus: EventBus;
  hub: PrivateOrderHub;
  durable: string;
  log?: HubLogger;
  /** Sequenced desk stream. The hub fan-out stays; this journal is additional. */
  positions?: PositionsStream;
}): Promise<Subscription> {
  const { bus, hub, durable, log, positions } = input;

  return bus
    .subscribe(
      'positionUpdated',
      (payload) => {
        if (positions) positions.ingest(payload);
        hub.publishPosition({
          positionId: payload.positionId,
          userId: payload.userId,
          marketId: payload.marketId,
          symbol: payload.symbol,
          status: payload.status,
          side: payload.side,
          contracts: payload.contracts,
          entryPrice: payload.entryPrice,
          markPrice: payload.markPrice,
          notional: payload.notional,
          leverage: payload.leverage,
          collateral: payload.collateral,
          unrealizedPnl: payload.unrealizedPnl,
          realizedPnl: payload.realizedPnl,
          liquidationPrice: payload.liquidationPrice,
          marginMode: payload.marginMode,
          fundingPaid: payload.fundingPaid,
          closingReason: payload.closingReason ?? null,
          ts: payload.ts,
        });
      },
      { durable },
    )
    .then((sub) => {
      log?.info({ durable, subject: 'positionUpdated' }, 'ws: private positions subscribed');
      return sub;
    });
}

export interface PrivateAttachments {
  readonly orders: Subscription;
  readonly fills: Subscription;
  readonly positions: Subscription;
}

/**
 * Attach all three private consumers, or none.
 * A partial attach (orders up, fills fail) would lie: ready frames say
 * `bus: true` while fills are silent. Tear whatever landed and return null
 * so the lifecycle can retry the half without touching the public tape.
 */
export async function tryAttachPrivate(input: {
  bus: EventBus;
  hub: PrivateOrderHub;
  durable: string;
  log?: HubLogger;
  positions?: PositionsStream;
}): Promise<PrivateAttachments | null> {
  let orders: Subscription | null = null;
  let fills: Subscription | null = null;
  let positions: Subscription | null = null;
  try {
    orders = await subscribePrivateOrders(input);
    fills = await subscribePrivateFills({
      ...input,
      durable: `${input.durable}-fills`,
    });
    input.positions?.markSourceAttached(true);
    positions = await subscribePrivatePositions({
      ...input,
      durable: `${input.durable}-positions`,
    });
    return { orders, fills, positions };
  } catch (err) {
    input.positions?.markSourceAttached(false);
    await orders?.unsubscribe().catch(() => undefined);
    await fills?.unsubscribe().catch(() => undefined);
    await positions?.unsubscribe().catch(() => undefined);
    input.log?.warn({ err: String(err) }, 'ws: private bus subscribe failed — trade tape still attached; private half will retry');
    return null;
  }
}
