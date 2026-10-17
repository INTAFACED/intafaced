import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import { OrderBook } from './book.js';
import type { EngineOrder, OrderSide } from './types.js';

/**
 * S06 / TRD-0254. Maker-or-cancel rests or it is rejected.
 * A buy at the best ask does not take and the price is not rewritten.
 */

const A = parseAmount;
const ASK = '11111111-1111-4111-8111-111111111111';
const BUY = '22222222-2222-4222-8222-222222222222';

function order(spec: { id: string; account?: string; side: OrderSide; qty: string; price: string; tif?: 'GTC' | 'MOC' }): EngineOrder {
  return {
    orderId: spec.id,
    accountId: spec.account ?? 'desk',
    type: 'limit',
    side: spec.side,
    qty: A(spec.qty),
    price: A(spec.price),
    stopPrice: null,
    tif: spec.tif ?? 'GTC',
  };
}

describe('maker-or-cancel rejects a take (TRD-0254)', () => {
  it('given BTC-USDT best ask 100, a limit buy at 100 with MOC is rejected and no fill is posted', () => {
    const book = new OrderBook('BTC-USDT');
    book.submit(order({ id: ASK, account: 'mm', side: 'sell', qty: '1', price: '100' }));

    const result = book.submit(order({ id: BUY, side: 'buy', qty: '1', price: '100', tif: 'MOC' }));

    expect(result.accepted).toBe(false);
    expect(result.rejected?.code).toBe('moc_would_take');
    expect(result.fills).toHaveLength(0);
    expect(result.resting).toBeNull();
    expect(formatAmount(book.bestAsk()!)).toBe('100');
    expect(book.bestBid()).toBeNull();
  });

  it('a retry with the same order id does not rest', () => {
    const book = new OrderBook('BTC-USDT');
    book.submit(order({ id: ASK, account: 'mm', side: 'sell', qty: '1', price: '100' }));
    book.submit(order({ id: BUY, side: 'buy', qty: '1', price: '100', tif: 'MOC' }));

    const again = book.submit(order({ id: BUY, side: 'buy', qty: '1', price: '99', tif: 'MOC' }));

    expect(again.accepted).toBe(false);
    expect(again.rejected?.code).toBe('duplicate_order_id');
    expect(again.fills).toHaveLength(0);
    expect(again.resting).toBeNull();
    expect(book.bestBid()).toBeNull();
    expect(formatAmount(book.bestAsk()!)).toBe('100');
  });

  it('a maker-or-cancel behind the ask rests at its own price', () => {
    const book = new OrderBook('BTC-USDT');
    book.submit(order({ id: ASK, account: 'mm', side: 'sell', qty: '1', price: '100' }));

    const result = book.submit(order({ id: BUY, side: 'buy', qty: '1', price: '99', tif: 'MOC' }));

    expect(result.accepted).toBe(true);
    expect(result.fills).toHaveLength(0);
    expect(formatAmount(result.resting!.price)).toBe('99');
    expect(formatAmount(book.bestAsk()!)).toBe('100');
  });
});
