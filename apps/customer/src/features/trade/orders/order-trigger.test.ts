import { describe, expect, it } from 'vitest';
import type { Order } from '../trade-api';
import { orderTrigger, slippageOf } from './order-trigger';

function stop(over: Partial<Order>): Order {
  return {
    id: 'o1',
    type: 'stop_limit',
    side: 'sell',
    stopPrice: '100',
    price: '95',
    average: null,
    amount: '1',
    filled: '0',
    remaining: '1',
    status: 'open',
    ...over,
  } as Order;
}

describe('a stop order’s trigger', () => {
  it('is not a stop for any other order', () => {
    expect(orderTrigger(stop({ type: 'limit', stopPrice: null }), false)).toEqual({ kind: 'not-stop' });
  });

  it('waits while open and not fired, and says "not recorded" once ended without a record', () => {
    expect(orderTrigger(stop({ triggered: null }), false)).toEqual({ kind: 'waiting', stopPrice: '100' });
    expect(orderTrigger(stop({ triggered: null, status: 'canceled' }), true)).toEqual({ kind: 'not-recorded', stopPrice: '100' });
  });

  it('says nothing it was not told: a wire without the field is "not stated"', () => {
    expect(orderTrigger(stop({}), false)).toEqual({ kind: 'not-stated', stopPrice: '100' });
  });

  it('reads when it fired, the price that reached it, and the slippage of its fills', () => {
    const fired = { at: '2026-10-23T03:00:00.000Z', by: 'last' as const, referencePrice: '99.5' };
    expect(orderTrigger(stop({ triggered: fired, filled: '1', average: '98', status: 'closed' }), true)).toEqual({
      kind: 'fired',
      stopPrice: '100',
      ...fired,
      slippage: { amount: '2', rate: '0.02' },
    });
    // Fired, nothing filled yet: no slippage to state.
    expect(orderTrigger(stop({ triggered: fired }), false)).toMatchObject({ kind: 'fired', slippage: null });
  });

  it('counts slippage against the person: below the stop for a sell, above it for a buy; better is negative', () => {
    expect(slippageOf('sell', '100', '99')).toEqual({ amount: '1', rate: '0.01' });
    expect(slippageOf('buy', '100', '101')).toEqual({ amount: '1', rate: '0.01' });
    expect(slippageOf('sell', '100', '100.5')).toEqual({ amount: '-0.5', rate: '-0.005' });
    expect(slippageOf('sell', '100', null)).toBeNull();
    expect(slippageOf('sell', 'x', '99')).toBeNull();
  });
});
