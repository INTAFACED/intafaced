import { describe, expect, it } from 'vitest';
import type { Order } from '../../../features/trade/trade-api';
import { canEdit, canEditStop, exitKindKey } from './order-kind';

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
  it('an OTO buy waiting for its fill cannot be edited (a replacement would drop its close); its close can', () => {
    expect(canEdit({ ...plain, linked: { role: 'entry', closePrice: '110', closeOrderId: null } })).toBe(false);
    expect(canEdit({ ...plain, linked: { role: 'close', entryOrderId: 'o-1' } })).toBe(true);
  });
  it('names the kind of an exit order', () => {
    expect(exitKindKey('oco')).toBe('Order type oco');
    expect(exitKindKey('bracket_exit')).toBe('Order type bracket exit');
  });
});

describe('changing a stop that has not fired', () => {
  const stop = {
    type: 'stop',
    status: 'open',
    recoveryRequired: false,
    price: '89.55',
    stopPrice: '90',
    filled: '0',
    triggered: null,
    exit: null,
  } as unknown as Order;
  it('a waiting stop-market or stop-limit can have its trigger changed', () => {
    expect(canEditStop(stop)).toBe(true);
    expect(canEditStop({ ...stop, type: 'stop_limit' })).toBe(true);
    // The limit editor is for plain limits only.
    expect(canEdit(stop)).toBe(false);
  });
  it('a fired, part-filled, linked, unknown or ended stop cannot', () => {
    expect(canEditStop({ ...stop, triggered: { at: '2026-10-24T00:00:00Z', by: 'last', referencePrice: '90' } } as Order)).toBe(false);
    expect(canEditStop({ ...stop, triggered: undefined } as Order)).toBe(false);
    expect(canEditStop({ ...stop, filled: '0.001' })).toBe(false);
    expect(canEditStop({ ...stop, exit: { kind: 'oco', takeProfit: '110', stopLoss: '90', stopLossLimit: null } })).toBe(false);
    expect(canEditStop({ ...stop, status: 'canceled' })).toBe(false);
    expect(canEditStop({ ...stop, recoveryRequired: true })).toBe(false);
    expect(canEditStop({ ...stop, type: 'limit' })).toBe(false);
  });
});
