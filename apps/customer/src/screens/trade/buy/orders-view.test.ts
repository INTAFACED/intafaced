import { describe, expect, it } from 'vitest';
import type { Order } from './deps';
import { baseOf, canCancel, pickRows, statusWord } from './orders-view';

const order = (over: Partial<Order>): Order =>
  ({
    id: 'o',
    timestamp: 1,
    symbol: 'BTC/USDT',
    side: 'buy',
    status: 'open',
    amount: '1',
    filled: '0',
    remaining: '1',
    recoveryRequired: false,
    recoveryReason: null,
    ...over,
  }) as Order;

describe('statusWord', () => {
  it('names each state in one word', () => {
    expect(statusWord(order({}))).toBe('open');
    expect(statusWord(order({ filled: '0.4', remaining: '0.6' }))).toBe('partly');
    expect(statusWord(order({ status: 'closed', filled: '1', remaining: '0' }))).toBe('filled');
    expect(statusWord(order({ status: 'canceled' }))).toBe('cancelled');
    expect(statusWord(order({ status: 'rejected' }))).toBe('rejected');
    expect(statusWord(order({ status: 'expired' }))).toBe('expired');
  });
  it('says being checked whenever recovery is required, and never guesses an unknown status', () => {
    expect(statusWord(order({ status: 'closed', recoveryRequired: true }))).toBe('checking');
    expect(statusWord(order({ status: 'weird' as Order['status'] }))).toBeNull();
  });
});

describe('canCancel', () => {
  it('only for a plain open order', () => {
    expect(canCancel(order({}))).toBe(true);
    expect(canCancel(order({ recoveryRequired: true }))).toBe(false);
    expect(canCancel(order({ status: 'closed' }))).toBe(false);
  });
});

describe('pickRows', () => {
  it('puts open first, then newest closed, once each, at most 20', () => {
    const open = [order({ id: 'a', timestamp: 5 }), order({ id: 'b', timestamp: 9 })];
    const closed = Array.from({ length: 30 }, (_, i) => order({ id: `c${i}`, status: 'closed', timestamp: 100 + i }));
    closed.push(order({ id: 'a', timestamp: 5 }));
    const rows = pickRows(open, closed);
    expect(rows).toHaveLength(20);
    expect(rows.slice(0, 2).map((r) => r.id)).toEqual(['b', 'a']);
    expect(rows[2]?.id).toBe('c29');
  });
  it('keeps an order being checked with the open ones', () => {
    const rows = pickRows(
      [],
      [order({ id: 'x', status: 'closed', timestamp: 1, recoveryRequired: true }), order({ id: 'y', status: 'closed', timestamp: 50 })],
    );
    expect(rows.map((r) => r.id)).toEqual(['x', 'y']);
  });
});

describe('baseOf', () => {
  it('reads the coin', () => {
    expect(baseOf('ETH/USDC')).toBe('ETH');
    expect(baseOf('ETHUSDC')).toBe('ETHUSDC');
  });
});
