/**
 * Copied positions (CB-copy-09/10): how sells come off each copied buy. A close of one position comes off that
 * position; any other sell comes off the oldest first; a sell still on the book is closing; less than a lot is not
 * open. Invariant: what is open plus what is closing never exceeds what was bought, and nothing goes below zero.
 */
import { parseAmount } from '@intafaced/ledger-client';
import { describe, expect, it } from 'vitest';
import { allocateCopiedPositions, sellEffect, sellableInMarket, type CopiedBuy, type CopiedSell } from './copied-positions.js';

const lot = parseAmount('0.0001');

function buy(n: number, received: string, over: Partial<CopiedBuy> = {}): CopiedBuy {
  return {
    orderId: `order-${n}`,
    leaderFillId: `fill-${n}`,
    symbol: 'BTC-USDT',
    marketId: 'm-btc',
    baseAsset: 'BTC',
    lotSize: lot,
    received: parseAmount(received),
    live: false,
    placedAt: new Date(Date.UTC(2026, 9, 24, 8, 0, n)),
    ...over,
  };
}

const sold = (qty: string): CopiedSell => ({ sold: parseAmount(qty), pending: 0n });
const resting = (qty: string): CopiedSell => ({ sold: 0n, pending: parseAmount(qty) });

describe('allocateCopiedPositions', () => {
  it('lists newest first and takes an unnamed sell off the oldest position first', () => {
    const rows = allocateCopiedPositions({
      buys: [buy(1, '0.5'), buy(2, '0.5')],
      targeted: new Map(),
      untargeted: new Map([['BTC-USDT', [sold('0.7')]]]),
    });
    expect(rows.map((r) => [r.orderId, r.open, r.status])).toEqual([
      ['order-2', parseAmount('0.3'), 'open'],
      ['order-1', 0n, 'closed'],
    ]);
  });

  it('takes a close of one position off that position only', () => {
    const rows = allocateCopiedPositions({
      buys: [buy(1, '0.5'), buy(2, '0.5')],
      targeted: new Map([['fill-2', [sold('0.5')]]]),
      untargeted: new Map(),
    });
    expect(rows.map((r) => [r.orderId, r.open, r.status])).toEqual([
      ['order-2', 0n, 'closed'],
      ['order-1', parseAmount('0.5'), 'open'],
    ]);
  });

  it('reads a sell on the book, or a close whose outcome is unknown, as closing, and it is not open', () => {
    const rows = allocateCopiedPositions({
      buys: [buy(1, '0.5')],
      targeted: new Map([['fill-1', [sellEffect({ qty: '0.2', filled_qty: '0', status: null })]]]),
      untargeted: new Map([['BTC-USDT', [resting('0.1')]]]),
    });
    expect(rows[0]).toMatchObject({ open: parseAmount('0.2'), closing: parseAmount('0.3'), status: 'closing' });
  });

  it('floors what is open to the lot, so dust below a lot is closed', () => {
    const rows = allocateCopiedPositions({
      buys: [buy(1, '0.50005')],
      targeted: new Map([['fill-1', [sold('0.5')]]]),
      untargeted: new Map(),
    });
    expect(rows[0]).toMatchObject({ open: 0n, status: 'closed' });
  });

  it('reads a buy that has not filled yet as buying, and a sell in another market leaves it alone', () => {
    const rows = allocateCopiedPositions({
      buys: [buy(1, '0', { live: true })],
      targeted: new Map(),
      untargeted: new Map([['ETH-USDT', [sold('1')]]]),
    });
    expect(rows[0]).toMatchObject({ open: 0n, status: 'buying' });
  });

  it('counts a cancelled sell as nothing sold and nothing closing', () => {
    expect(sellEffect({ qty: '1', filled_qty: '0.25', status: 'cancelled' })).toEqual({ sold: parseAmount('0.25'), pending: 0n });
    expect(sellEffect({ qty: '1', filled_qty: '0.25', status: 'open' })).toEqual({
      sold: parseAmount('0.25'),
      pending: parseAmount('0.75'),
    });
  });

  it('never shows more open and closing than was bought, and never below zero (invariant)', () => {
    const amounts = ['0', '0.0001', '0.1', '0.25', '0.5', '1'];
    for (const a of amounts) {
      for (const b of amounts) {
        for (const t of amounts) {
          for (const u of amounts) {
            for (const p of amounts) {
              const rows = allocateCopiedPositions({
                buys: [buy(1, a), buy(2, b)],
                targeted: new Map([['fill-2', [sold(t)]]]),
                untargeted: new Map([['BTC-USDT', [sold(u), resting(p)]]]),
              });
              for (const row of rows) {
                expect(row.open >= 0n && row.closing >= 0n).toBe(true);
                expect(row.open + row.closing <= row.bought).toBe(true);
              }
              const totalOpen = sellableInMarket(rows, 'BTC-USDT');
              const bought = parseAmount(a) + parseAmount(b);
              expect(totalOpen <= bought).toBe(true);
            }
          }
        }
      }
    }
  });
});
