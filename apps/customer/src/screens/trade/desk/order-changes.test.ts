import { describe, expect, it } from 'vitest';
import { changeLine } from './order-changes';

const base = { at: '2026-10-01T00:00:00.000Z', quantity: null, price: null, version: null, relatedOrderId: null, direction: null } as const;

describe('changeLine', () => {
  it('says an amend with its own amount and price', () => {
    expect(changeLine({ ...base, kind: 'amend', quantity: '2', price: '55', version: '1' })).toEqual({
      key: 'Order changes amend',
      at: base.at,
      amount: '2',
      price: '55',
    });
  });
  it('leaves out an amend with no stored amount or price', () => {
    expect(changeLine({ ...base, kind: 'amend', quantity: '2' })).toBeNull();
    expect(changeLine({ ...base, kind: 'amend', price: '2' })).toBeNull();
  });
  it('says which way a replace points, and nothing when it does not say', () => {
    expect(changeLine({ ...base, kind: 'replace', relatedOrderId: 'x', direction: 'replaced_by' })?.key).toBe('Order changes replaced by');
    expect(changeLine({ ...base, kind: 'replace', relatedOrderId: 'x', direction: 'replaces' })?.key).toBe('Order changes replaces');
    expect(changeLine({ ...base, kind: 'replace' })).toBeNull();
  });
});
