import { describe, expect, it } from 'vitest';
import type { Order } from '../../../features/trade/trade-api';
import { canEdit, exitKindKey } from './order-kind';

const plain = {
  type: 'limit',
  status: 'open',
  recoveryRequired: false,
  price: '100',
  timeInForce: 'GTC',
  postOnly: false,
} as Order;

describe('order kind in the tables', () => {
  it('a plain resting limit can be edited; an order with linked exit legs cannot', () => {
    expect(canEdit(plain)).toBe(true);
    expect(canEdit({ ...plain, exit: { kind: 'oco', takeProfit: '110', stopLoss: '90', stopLossLimit: null } })).toBe(false);
    expect(canEdit({ ...plain, exit: { kind: 'bracket_exit', takeProfit: '110', stopLoss: '90', stopLossLimit: '91' } })).toBe(false);
    expect(canEdit({ ...plain, exit: null })).toBe(true);
  });
  it('names the kind of an exit order', () => {
    expect(exitKindKey('oco')).toBe('Order type oco');
    expect(exitKindKey('bracket_exit')).toBe('Order type bracket exit');
  });
});
