import { describe, expect, it } from 'vitest';
import { assetSelectField, heldAssets } from './holdings';

describe('assets the customer holds', () => {
  it('lists assets with something in them, dollar coins first, balances exact', () => {
    const held = heldAssets([
      { assetId: 'BTC', available: '0.000000000000000001', held: null, quantity: null },
      { assetId: 'ETH', available: '0', held: null, quantity: null },
      { assetId: 'USDT', available: '12.50', held: null, quantity: null },
    ]);
    expect(held).toEqual([
      { assetId: 'USDT', available: '12.5' },
      { assetId: 'BTC', available: '0.000000000000000001' },
    ]);
  });
  it('falls back to the customer’s own accounts when the balance feed is down', () => {
    expect(heldAssets([], [{ assetId: 'SOL', balance: '3' }])).toEqual([{ assetId: 'SOL', available: '3' }]);
  });
  it('keeps the larger figure when two sources disagree on one asset', () => {
    expect(heldAssets([{ assetId: 'BTC', available: '1', held: null, quantity: null }], [{ assetId: 'BTC', balance: '2' }])).toEqual([
      { assetId: 'BTC', available: '1' },
    ]);
  });
  it('skips unreadable amounts instead of guessing', () => {
    expect(heldAssets([{ assetId: 'BTC', available: 'abc', held: null, quantity: null }])).toEqual([]);
  });
  it('builds a pick list, never a free text box', () => {
    const field = assetSelectField('Asset', 'hint', [{ assetId: 'USDT', available: '1' }]);
    expect(field.options).toEqual([{ value: 'USDT', label: 'USDT' }]);
  });
});
