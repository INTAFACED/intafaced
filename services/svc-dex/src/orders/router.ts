import { router } from '@intafaced/contracts/trpc';
import { DEX_ORDERS_COUNT } from '@intafaced/contracts/dex-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { dexRefusal } from '../refusal.js';
import type { OrderBook } from '../order/order-book.js';

/**
 * `orders.*`: the person's own wallet orders (D-limit-dca-04). `count` is public: it says how many orders a wallet has
 * and nothing else (no terms, no prices, no states), so the Orders room can say "No orders yet." before a session is
 * signed. Every read of an order's terms needs the wallet's order session. Mounted from its record
 * (`@intafaced/contracts/dex-procedures`).
 */
export function walletOrdersRouter(book: OrderBook) {
  return router({
    count: mountRecord(DEX_ORDERS_COUNT, ({ input }) => ({ wallet: input.wallet, count: book.countByMaker(input.wallet) }), dexRefusal),
  });
}
