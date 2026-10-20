import { describe, expect, it } from 'vitest';
import { parseAmount as A } from '@intafaced/ledger-client/money';
import { OrderBook } from './book.js';
import { readSpreadListing } from './spread-instrument.js';
import type { EngineOrder } from './types.js';

/**
 * Without the spread-book hitch (no MatchingEngine constructed, nothing installed), the core book must refuse a
 * spread order outright: it would otherwise rest a signed spread price with no leg pricing and no rehearsal.
 */
describe('core book without the spread hitch', () => {
  it('refuses a spread order spread_order_unsupported and takes no sequence', () => {
    const read = readSpreadListing({
      spreadId: 'BTC-CAL',
      kind: 'calendar',
      legs: [
        { symbol: 'BTC-27MAR', side: 'sell', ratio: '1' },
        { symbol: 'BTC-26JUN', side: 'buy', ratio: '1' },
      ],
      tick: '0.5',
      lot: '0.001',
    });
    if (!read.ok) throw new Error(read.rejected.message);
    const order: EngineOrder = {
      orderId: '00000000-0000-4000-8000-000000000001',
      accountId: 'acct',
      type: 'limit',
      side: 'buy',
      qty: A('1'),
      price: A('-5'),
      stopPrice: null,
      tif: 'GTC',
      spread: { instrument: read.instrument, anchorReference: A('100') },
    };
    const book = new OrderBook('BTC-CAL');
    const result = book.submit(order);
    expect(result.rejected?.code).toBe('spread_order_unsupported');
    expect(book.currentSequence).toBe(0);
  });
});
