/**
 * Follower flatten port (TRD-0723).
 *
 * Closes the follow's own mirrored spot longs. Quantity is the filled size of
 * this follow's mirror orders (`copy_placed_mirrors` joined to that follower's
 * fills), never the plan quantity on `copy_mirrored_fills`. Spot is long only:
 * a net at or below zero is nothing to close.
 *
 * The sell is an ordinary limit at the DESKAPI floor `sellProtectionPriceFor`
 * (best bid minus `TRADE_MARKET_SLIPPAGE_CAP_BPS`). A missing floor, bid, or
 * closed market refuses. The sell never exceeds the mirrored net, and a
 * balance below that net places nothing (`trade.copy_flatten_drift`).
 *
 * Order of effects inside this port: fence new intent (STOPPING, session key
 * still live), then place. Detach and session-key revoke stay with
 * `CopyService.flatten`, and only after every market has an order. A later
 * market refusing returns `partial` with the ids already placed; the follow
 * stays fenced. Replay uses a client id derived from the follow and market.
 *
 * `TRADE_COPY_PLACE_MIRROR` is not read here and is not turned on. The door
 * refuses that flag (and a missing place port) before it calls this.
 */
import { createHash } from 'node:crypto';
import type { Principal } from '@intafaced/auth';
import { parseAmount, userAvailable, type Amount, type LedgerClient } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { CopyError } from './errors.js';
import type { CopyFollowStore } from './follow-store.js';
import { followRelationshipState } from './copy-lifecycle.js';
import type { FlattenCopyPositionInput, FlattenCopyPositionPort, FlattenCopyPositionResult } from './copy-flatten.js';
import { COPY_MIRROR_CLIENT_ORDER_ID_MAX, type PlaceFollowerOrderPort } from './auto-mirror-place.js';
import { assertMarketOpen, assertNotional, assertPrice, assertQty, assertTradable, sellProtectionPriceFor } from '../spot/risk.js';
import { TradeError, type Market } from '../spot/types.js';

export function copyFlattenClientOrderId(followId: string, marketSymbol: string): string {
  const readable = `copy-flatten:${followId}:${marketSymbol}`;
  if (readable.length <= COPY_MIRROR_CLIENT_ORDER_ID_MAX) return readable;
  return createHash('sha256').update(readable).digest('hex').slice(0, COPY_MIRROR_CLIENT_ORDER_ID_MAX);
}

export type FollowerFlattenPortDeps = {
  readonly sql: Sql;
  readonly ledger: LedgerClient;
  readonly store: CopyFollowStore;
  readonly placeFollowerOrder: PlaceFollowerOrderPort;
  /** Owner cap. Blank is `trade.protection_unset` inside `sellProtectionPriceFor`, mapped to unavailable. */
  readonly slippageCapBps: number | null;
  readonly loadMarket: (symbol: string) => Promise<Market | null>;
  /** Same bid the market-sell path reads: top of book, or null when the book has none. */
  readonly bestBid: (marketId: string) => Promise<Amount | null>;
  readonly now?: () => Date;
};

type MirrorFillRow = {
  symbol: string;
  base_asset: string;
  side: string;
  qty: string;
};

type ExistingOrderRow = {
  id: string;
};

type Leg = {
  readonly symbol: string;
  readonly baseAsset: string;
  readonly qty: Amount;
};

type PricedLeg = {
  readonly symbol: string;
  readonly marketId: string;
  readonly price: Amount;
};

export function createFollowerFlattenPort(deps: FollowerFlattenPortDeps): FlattenCopyPositionPort {
  const now = deps.now ?? (() => new Date());

  return async function flattenCopyPosition(principal: Principal, input: FlattenCopyPositionInput): Promise<FlattenCopyPositionResult> {
    if (principal.userId !== input.followerId) {
      throw new CopyError('Follow belongs to another user', 'trade.copy_not_following');
    }

    const legs = await netMirroredLongs(deps.sql, input.followId, input.followerId);
    if (legs instanceof Refuse) return { orderIds: [], refuse: legs.refuse };

    const already: string[] = [];
    const pending: Leg[] = [];
    for (const leg of legs) {
      const existing = await findFlattenOrder(deps.sql, input.followerId, leg.symbol, copyFlattenClientOrderId(input.followId, leg.symbol));
      if (existing) already.push(existing);
      else pending.push(leg);
    }

    if (pending.length === 0) {
      return { orderIds: already };
    }

    const drifted = await mirroredQtyExceedsAvailable(deps.ledger, input.followerId, pending);
    if (drifted) return { orderIds: [], refuse: 'drift' };

    const placed = [...already];
    let fenced = false;
    for (const leg of pending) {
      let priced: PricedLeg;
      try {
        priced = await protectionFloor(deps, leg, now());
      } catch (err) {
        if (err instanceof CopyError) throw err;
        if (!(err instanceof TradeError)) throw err;
        if (placed.length === 0) return { orderIds: [], refuse: 'unavailable' };
        return { orderIds: placed, refuse: 'partial' };
      }

      if (!fenced) {
        await fenceNewIntent(deps.store, input.followId);
        fenced = true;
      }

      try {
        const clientOrderId = copyFlattenClientOrderId(input.followId, leg.symbol);
        const order = await deps.placeFollowerOrder(principal, {
          followId: input.followId,
          symbol: priced.symbol,
          marketId: priced.marketId,
          side: 'sell',
          qty: leg.qty,
          price: priced.price,
          clientOrderId,
        });
        placed.push(order.orderId);
      } catch (err) {
        if (err instanceof CopyError && err.code === 'trade.copy_not_following') throw err;
        return { orderIds: placed, refuse: 'partial' };
      }
    }

    return { orderIds: placed };
  };
}

class Refuse {
  constructor(readonly refuse: 'unavailable') {}
}

/**
 * Net filled quantity per market for this follow's own mirror orders.
 * Buy fills add, sell fills subtract. Plan rows are not read.
 */
async function netMirroredLongs(sql: Sql, followId: string, followerId: string): Promise<Leg[] | Refuse> {
  const rows = await sql<MirrorFillRow[]>`
    SELECT m.symbol, m.base_asset, f.side, f.qty::text AS qty
      FROM trade.copy_placed_mirrors p
      INNER JOIN trade.orders o ON o.id::text = p.order_id
      INNER JOIN trade.fills f ON f.order_id = o.id
      INNER JOIN trade.markets m ON m.id = f.market_id
     WHERE p.follow_id = ${followId}
       AND o.user_id = ${followerId}::uuid
       AND f.user_id = ${followerId}::uuid
  `;

  const nets = new Map<string, { baseAsset: string; net: Amount }>();
  for (const row of rows) {
    if (row.side !== 'buy' && row.side !== 'sell') return new Refuse('unavailable');
    const qty = parseAmount(row.qty);
    const signed = row.side === 'buy' ? qty : -qty;
    const prior = nets.get(row.symbol);
    if (!prior) {
      nets.set(row.symbol, { baseAsset: row.base_asset, net: signed });
      continue;
    }
    if (prior.baseAsset !== row.base_asset) return new Refuse('unavailable');
    nets.set(row.symbol, { baseAsset: prior.baseAsset, net: prior.net + signed });
  }

  const legs: Leg[] = [];
  for (const [symbol, bucket] of nets) {
    if (bucket.net <= 0n) continue;
    legs.push({ symbol, baseAsset: bucket.baseAsset, qty: bucket.net });
  }
  legs.sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  return legs;
}

async function findFlattenOrder(sql: Sql, followerId: string, symbol: string, clientOrderId: string): Promise<string | null> {
  const rows = await sql<ExistingOrderRow[]>`
    SELECT o.id::text AS id
      FROM trade.orders o
      INNER JOIN trade.markets m ON m.id = o.market_id
     WHERE o.user_id = ${followerId}::uuid
       AND m.symbol = ${symbol}
       AND o.client_order_id = ${clientOrderId}
       AND o.side = 'sell'
     LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

/** Available below the mirrored net refuses the whole call. Never sell the lesser amount. */
async function mirroredQtyExceedsAvailable(ledger: LedgerClient, followerId: string, pending: readonly Leg[]): Promise<boolean> {
  const need = new Map<string, Amount>();
  for (const leg of pending) {
    need.set(leg.baseAsset, (need.get(leg.baseAsset) ?? 0n) + leg.qty);
  }
  for (const [assetId, qty] of need) {
    const available = await ledger.balance(userAvailable(followerId, assetId));
    if (available.amount < qty) return true;
  }
  return false;
}

async function protectionFloor(deps: FollowerFlattenPortDeps, leg: Leg, at: Date): Promise<PricedLeg> {
  const market = await deps.loadMarket(leg.symbol);
  if (!market || market.kind !== 'spot' || market.symbol !== leg.symbol || market.baseAsset !== leg.baseAsset) {
    throw new TradeError(`${leg.symbol} is not an open spot market for this flatten`, 'trade.market_not_tradable');
  }
  assertTradable(market, { now: at });
  assertMarketOpen(market, at);
  const bid = await deps.bestBid(market.id);
  const price = sellProtectionPriceFor(market, bid, deps.slippageCapBps);
  assertQty(market, leg.qty);
  assertPrice(market, price);
  assertNotional(market, price, leg.qty);
  return { symbol: market.symbol, marketId: market.id, price };
}

/** STOP_NEW fence without revoking the session key. Detach revokes, and only after every market places. */
async function fenceNewIntent(store: CopyFollowStore, followId: string): Promise<void> {
  const follow = await store.getFollow(followId);
  if (!follow) {
    throw new CopyError('Follow not found', 'trade.copy_not_following');
  }
  const state = followRelationshipState(follow);
  if (state === 'STOPPING' || state === 'DETACHED') return;
  await store.saveFollow({ ...follow, relationshipState: 'STOPPING' });
}
