/**
 * MKT-0122 — the public tape id is the print sequence, not trade.fills.id.
 * Maker and taker order ids stay off the print. The private fill keeps id F.
 */
import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { publicTapePrint } from './public-tape.js';
import { toFill, type FillRow } from './rows.js';

const TS = new Date('2026-10-17T00:00:09.000Z');

describe('MKT-0122 public tape id', () => {
  it('prints sequence 9 as the public id and leaves fill id F and both order ids off the print', () => {
    const print = publicTapePrint({
      id: 'F',
      side: 'buy',
      price: parseAmount('101'),
      qty: parseAmount('1'),
      quoteAmount: parseAmount('101'),
      sequence: 9,
      ts: TS,
      orderId: 'maker-order',
      counterOrderId: 'taker-order',
    });

    expect(print.id).toBe('9');
    expect(print.id).not.toBe('F');
    expect(print.sequence).toBe(9);
    expect(print).not.toHaveProperty('orderId');
    expect(print).not.toHaveProperty('counterOrderId');
    expect(Object.values(print).map((value) => String(value))).not.toContain('F');
    expect(Object.values(print).map((value) => String(value))).not.toContain('maker-order');
    expect(Object.values(print).map((value) => String(value))).not.toContain('taker-order');
  });

  it('keeps the private fill id as F when the sequence is 9', () => {
    const row: FillRow = {
      id: 'F',
      order_id: 'maker-order',
      counter_order_id: 'taker-order',
      market_id: 'm1',
      user_id: 'u1',
      side: 'buy',
      liquidity: 'taker',
      price: '101',
      qty: '1',
      quote_amount: '101',
      fee_asset: 'USDT',
      fee_amount: '0',
      fee_bps: '0',
      sequence: 9,
      ts: TS,
      session_id: null,
      api_key_id: null,
    };
    expect(toFill(row).id).toBe('F');
    expect(toFill(row).sequence).toBe(9);
  });
});
