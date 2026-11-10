import { publicJurisdictionProcedure, router } from '@intafaced/contracts';
import { dexOrdersCountInputSchema, dexOrdersCountOutputSchema } from '@intafaced/contracts/protocol-dex-orders';
import type { OrderBook } from '../order/order-book.js';

/**
 * `orders.*`: the person's own wallet orders (D-limit-dca-04). `count` is public: it says how many orders a wallet has
 * and nothing else (no terms, no prices, no states), so the Orders room can say "No orders yet." before a session is
 * signed. Every read of an order's terms needs the wallet's order session.
 */
export function walletOrdersRouter(book: OrderBook) {
  const door = publicJurisdictionProcedure('dex', 'protocol');
  return router({
    count: door
      .input(dexOrdersCountInputSchema)
      .output(dexOrdersCountOutputSchema)
      .mutation(({ input }) => ({ wallet: input.wallet, count: book.countByMaker(input.wallet) })),
  });
}
