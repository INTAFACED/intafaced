import { describe, expect, it } from 'vitest';
import { parseAmount as A } from '@intafaced/ledger-client/money';
import './engine.js';
import { replay, toWire } from './journal.js';
import type { JournalRecord } from './journal.js';
import type { EngineOrder } from './types.js';

const MARKET = 'BTC/USDT';
const ID = '11111111-1111-4111-8111-111111111111';
const bare = (extra: Record<string, unknown>) =>
  ({
    orderId: ID,
    accountId: 'desk',
    type: 'limit',
    side: 'sell',
    qty: A('1'),
    price: A('100'),
    stopPrice: null,
    tif: 'GTC',
    ...extra,
  }) as unknown as EngineOrder;
const tape = (order: EngineOrder): JournalRecord[] => [
  { kind: 'submit', marketId: MARKET, at: '2026-10-19T08:00:00.000Z', seq: 1, order: toWire(order) },
];

describe('OCO submits replay the way they ran live', () => {
  it('a refused bare oco order stays refused after replay: nothing rests', () => {
    const book = replay(tape(bare({ oco: true }))).get(MARKET);
    expect(book?.toState().asks ?? []).toEqual([]);
    expect(book?.toState().stops ?? []).toEqual([]);
  });

  it('a full oco submit replays to the same two legs', () => {
    const book = replay(tape(bare({ oco: true, takeProfit: A('110'), stopLoss: A('90') }))).get(MARKET)!;
    expect(book.toState().asks[0]!.orders[0]!.orderId).toBe(`${ID}:tp`);
    expect(book.toState().stops.map((s) => s.orderId)).toEqual([`${ID}:sl`]);
  });
});
