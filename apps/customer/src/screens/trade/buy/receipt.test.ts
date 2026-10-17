import { describe, expect, it } from 'vitest';
import type { Trade } from '@intafaced/exchange-contract/schemas';
import type { Order } from './deps';
import { fillsComplete } from './order-flow';
import { fillsOf, receiptFrom } from './receipt';

/** A market buy as the service really returns it (checked on the local stack): cost from the reserved price, no average, no fee, no fills. */
const order = (overrides: Partial<Order> = {}): Order =>
  ({
    id: 'o-1',
    clientOrderId: 'buy:abc',
    timestamp: 1,
    datetime: '2026-10-14T00:00:00.000Z',
    lastTradeTimestamp: null,
    symbol: 'BTC/USDT',
    type: 'market',
    side: 'buy',
    timeInForce: 'IOC',
    postOnly: false,
    reduceOnly: false,
    price: null,
    stopPrice: null,
    average: null,
    amount: '0.00015',
    filled: '0.00015',
    remaining: '0',
    cost: '9.800889',
    status: 'closed',
    fee: null,
    trades: [],
    recoveryRequired: false,
    recoveryReason: null,
    reconciliationKey: null,
    ...overrides,
  }) as Order;

const trade = (overrides: Partial<Trade> = {}): Trade => ({
  id: 't-1',
  order: 'o-1',
  timestamp: 1,
  datetime: '2026-10-14T00:00:00.000Z',
  symbol: 'BTC/USDT',
  type: null,
  side: 'buy',
  takerOrMaker: 'taker',
  price: '65014.18',
  amount: '0.00015',
  cost: '9.752127',
  fee: { cost: '0.00000015', currency: 'BTC', rate: '0.001' },
  ...overrides,
});

describe('receiptFrom', () => {
  it('reads what was really paid from the fills, never from the order cost (9.80 reserved against 9.75 paid)', () => {
    const receipt = receiptFrom(order(), [trade()]);
    expect(receipt).toMatchObject({
      status: 'filled',
      filled: '0.00015',
      cost: '9.752127',
      average: '65014.18',
      fee: { cost: '0.00000015', currency: 'BTC' },
    });
  });

  it('adds up several fills and keeps one fee line when they charged the same asset', () => {
    const receipt = receiptFrom(order({ amount: '0.0002', filled: '0.0002' }), [
      trade({ amount: '0.0001', cost: '6.5', price: '65000' }),
      trade({ id: 't-2', amount: '0.0001', cost: '6.502', price: '65020', fee: { cost: '0.0000001', currency: 'BTC', rate: '0.001' } }),
    ]);
    expect(receipt).toMatchObject({ filled: '0.0002', cost: '13.002', average: '65010', fee: { cost: '0.00000025', currency: 'BTC' } });
  });

  it('leaves the fee out rather than add two different assets', () => {
    const receipt = receiptFrom(order({ amount: '0.0002', filled: '0.0002' }), [
      trade({ amount: '0.0001' }),
      trade({ id: 't-2', amount: '0.0001', fee: { cost: '0.01', currency: 'USDT', rate: null } }),
    ]);
    expect(receipt.fee).toBeNull();
  });

  it('shows no money, not the reserved cost, until the fills can be read', () => {
    const receipt = receiptFrom(order(), null);
    expect(receipt).toMatchObject({ status: 'filled', filled: '0.00015', cost: null, average: null, fee: null });
    expect(receiptFrom(order(), [trade({ order: 'another-order' })]).cost).toBeNull();
  });

  it('only counts the fills of THIS order', () => {
    expect(fillsOf({ id: 'o-1' }, [trade({ order: 'o-2' }), trade({ id: 't-3' })])).toHaveLength(1);
    expect(fillsOf({ id: 'o-1' }, [])).toBeNull();
    expect(fillsOf({ id: 'o-1' }, null)).toBeNull();
  });

  it('tells a partial fill, no fill, and a still-working order apart', () => {
    expect(receiptFrom(order({ filled: '0.0001' }), null).status).toBe('partial');
    expect(receiptFrom(order({ filled: '0', status: 'expired', cost: '0' }), null).status).toBe('none');
    expect(receiptFrom(order({ filled: '0', status: 'rejected', cost: null }), null).status).toBe('none');
    expect(receiptFrom(order({ status: 'open', remaining: '0.00015', filled: '0' }), null).status).toBe('open');
  });

  it('never lets a truncated fill list lower "bought", raise "partly filled" or understate "paid"', () => {
    // The order filled 0.00015 in two fills; only one of them is in the (capped, newest-first) list.
    const two = order({ filled: '0.00015', amount: '0.00015' });
    const receipt = receiptFrom(two, [trade({ amount: '0.0001', cost: '6.5' })]);
    expect(receipt).toMatchObject({ status: 'filled', filled: '0.00015', cost: null, average: null, fee: null });
  });

  it('says "partly filled" only when the order itself filled less than asked', () => {
    expect(receiptFrom(order({ filled: '0.0001', status: 'closed' }), [trade({ amount: '0.0001', cost: '6.5' })])).toMatchObject({
      status: 'partial',
      filled: '0.0001',
      cost: '6.5',
    });
    expect(receiptFrom(order(), [trade({ amount: '0.00005', cost: '3' })]).status).toBe('filled');
  });
});

describe('fillsComplete', () => {
  const o = { id: 'o-1', filled: '0.00015' };
  it('accepts only fills that add up to the order', () => {
    expect(fillsComplete(o, [trade({ amount: '0.0001' }), trade({ id: 't2', amount: '0.00005' })])).toBe(true);
    expect(fillsComplete(o, [trade({ amount: '0.0001' })])).toBe(false);
    expect(fillsComplete(o, [])).toBe(false);
    expect(fillsComplete(o, [trade({ amount: '0.00015', order: 'other' })])).toBe(false);
    expect(fillsComplete({ id: 'o-1', filled: 'x' }, [trade()])).toBe(false);
  });
});
