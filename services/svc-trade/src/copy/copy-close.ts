/**
 * A follower's close of one copied position (CB-copy-10).
 *
 * The close is an ordinary limit sell at the protection floor below the best bid (the same floor a flatten uses), as
 * the follower, of the follower's own coin. It runs once per close key: the key's row in `copy_close_orders` is written
 * before the order is placed and names the order's client id, its derived order id, its quantity and its price. A
 * retry under the same key finds that row: an order already on the book is returned as it is, and an order that never
 * reached the book is placed again with the same client id, quantity and price, so the spot path's own once-per-client-id
 * holds and no second sell can exist. A typed refusal of the place removes the row, since nothing was placed; any other
 * failure keeps it, and the position reads as closing until a retry settles it.
 */
import { createHash } from 'node:crypto';
import type { Principal } from '@intafaced/auth';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { COPY_MIRROR_CLIENT_ORDER_ID_MAX, type PlaceFollowerOrderPort } from './auto-mirror-place.js';
import { protectionFloor, type FollowerFlattenPortDeps } from './follower-flatten-port.js';
import { isCopySkipRefusal } from './skip-log.js';
import { orderIdFor } from '../spot/ids.js';

/** The close key: a whole close of one copied position, or a part of it by amount. */
export function copyCloseKey(followId: string, leaderFillId: string, partialQty: Amount | null): string {
  const whole = `copy.close:${followId}:${leaderFillId}`;
  return partialQty === null ? whole : `${whole}:${formatAmount(partialQty)}`;
}

export function copyCloseClientOrderId(closeKey: string): string {
  if (closeKey.length <= COPY_MIRROR_CLIENT_ORDER_ID_MAX) return closeKey;
  return createHash('sha256').update(closeKey).digest('hex').slice(0, COPY_MIRROR_CLIENT_ORDER_ID_MAX);
}

export type CopyCloseRecord = {
  readonly closeKey: string;
  readonly followId: string;
  readonly leaderFillId: string;
  readonly followerOrderId: string;
  readonly clientOrderId: string;
  readonly symbol: string;
  readonly marketId: string;
  readonly qty: Amount;
  readonly price: Amount;
};

export type CopyClosePlaceInput = {
  readonly closeKey: string;
  readonly followId: string;
  readonly followerId: string;
  readonly leaderFillId: string;
  readonly symbol: string;
  readonly baseAsset: string;
  readonly qty: Amount;
};

export type CopyClosePort = {
  /** The record under this key, if a close was asked for under it before. */
  find(closeKey: string): Promise<CopyCloseRecord | null>;
  /** Places again a recorded close whose order is not on the book; returns the order id. */
  resume(principal: Principal, record: CopyCloseRecord): Promise<{ orderId: string }>;
  /** Prices, records and places a new close. */
  place(principal: Principal, input: CopyClosePlaceInput): Promise<{ orderId: string }>;
};

type CloseRow = {
  close_key: string;
  follow_id: string;
  leader_fill_id: string;
  follower_order_id: string;
  client_order_id: string;
  symbol: string;
  market_id: string;
  qty: string;
  price: string;
};

export function createCopyClosePort(
  deps: Pick<FollowerFlattenPortDeps, 'sql' | 'placeFollowerOrder' | 'loadMarket' | 'bestBid' | 'slippageCapBps' | 'now'>,
): CopyClosePort {
  const now = deps.now ?? (() => new Date());
  const sql: Sql = deps.sql;

  async function find(closeKey: string): Promise<CopyCloseRecord | null> {
    const [row] = await sql<CloseRow[]>`
      SELECT c.close_key, c.follow_id, c.leader_fill_id, c.follower_order_id, c.client_order_id,
             m.symbol, m.id::text AS market_id, c.qty::text AS qty, c.price::text AS price
        FROM trade.copy_close_orders c
        INNER JOIN trade.copy_placed_mirrors pm ON pm.follow_id = c.follow_id AND pm.fill_id = c.leader_fill_id
        INNER JOIN trade.orders b ON b.id::text = pm.order_id
        INNER JOIN trade.markets m ON m.id = b.market_id
       WHERE c.close_key = ${closeKey}
       LIMIT 1
    `;
    if (!row) return null;
    return {
      closeKey: row.close_key,
      followId: row.follow_id,
      leaderFillId: row.leader_fill_id,
      followerOrderId: row.follower_order_id,
      clientOrderId: row.client_order_id,
      symbol: row.symbol,
      marketId: row.market_id,
      qty: parseAmount(row.qty),
      price: parseAmount(row.price),
    };
  }

  async function orderExists(record: CopyCloseRecord): Promise<boolean> {
    const rows = await sql<
      Array<{ id: string }>
    >`SELECT o.id::text AS id FROM trade.orders o WHERE o.id::text = ${record.followerOrderId} LIMIT 1`;
    return rows.length > 0;
  }

  async function send(principal: Principal, record: CopyCloseRecord): Promise<{ orderId: string }> {
    try {
      const placed = await deps.placeFollowerOrder(principal, {
        followId: record.followId,
        symbol: record.symbol,
        marketId: record.marketId,
        side: 'sell',
        qty: record.qty,
        price: record.price,
        clientOrderId: record.clientOrderId,
      });
      return { orderId: placed.orderId };
    } catch (err) {
      // A typed refusal placed nothing: the key is free again. Anything else may have placed; keep the record.
      if (isCopySkipRefusal(err) && !(await orderExists(record))) {
        await sql`DELETE FROM trade.copy_close_orders WHERE close_key = ${record.closeKey}`;
      }
      throw err;
    }
  }

  return {
    find,
    async resume(principal, record) {
      if (await orderExists(record)) return { orderId: record.followerOrderId };
      return send(principal, record);
    },
    async place(principal, input) {
      const priced = await protectionFloor(deps, { symbol: input.symbol, baseAsset: input.baseAsset, qty: input.qty }, now());
      const clientOrderId = copyCloseClientOrderId(input.closeKey);
      const record: CopyCloseRecord = {
        closeKey: input.closeKey,
        followId: input.followId,
        leaderFillId: input.leaderFillId,
        followerOrderId: orderIdFor(input.followerId, priced.marketId, clientOrderId),
        clientOrderId,
        symbol: priced.symbol,
        marketId: priced.marketId,
        qty: input.qty,
        price: priced.price,
      };
      const inserted = await sql<Array<{ close_key: string }>>`
        INSERT INTO trade.copy_close_orders (close_key, follow_id, leader_fill_id, follower_order_id, client_order_id, qty, price)
        VALUES (${record.closeKey}, ${record.followId}, ${record.leaderFillId}, ${record.followerOrderId}, ${record.clientOrderId},
                ${formatAmount(record.qty)}, ${formatAmount(record.price)})
        ON CONFLICT (close_key) DO NOTHING
        RETURNING close_key
      `;
      if (inserted.length === 0) {
        const prior = await find(input.closeKey);
        if (prior) return this.resume(principal, prior);
      }
      return send(principal, record);
    },
  };
}
