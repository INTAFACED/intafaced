import { describe, expect, it } from 'vitest';
import { asAssetId } from '@intafaced/contracts/asset-id';
import { assetSelectField, heldAssets, spaceTotals } from './holdings';

describe('assets the customer holds', () => {
  it('lists assets with something in them, dollar coins first, balances exact', () => {
    const held = heldAssets([
      { assetId: asAssetId('BTC'), available: '0.000000000000000001', held: null, quantity: null },
      { assetId: asAssetId('ETH'), available: '0', held: null, quantity: null },
      { assetId: asAssetId('USDT'), available: '12.50', held: null, quantity: null },
    ]);
    expect(held).toEqual([
      { assetId: asAssetId('USDT'), available: '12.5' },
      { assetId: asAssetId('BTC'), available: '0.000000000000000001' },
    ]);
  });
  it('falls back to the customer’s own accounts when the balance feed is down', () => {
    expect(heldAssets([], [{ assetId: asAssetId('SOL'), balance: '3' }])).toEqual([{ assetId: asAssetId('SOL'), available: '3' }]);
  });
  it('uses the account when the balance feed reads 0, as it does for money the partner bank holds', () => {
    expect(
      heldAssets(
        [{ assetId: asAssetId('USDT'), available: '0', held: null, quantity: null }],
        [{ assetId: asAssetId('USDT'), balance: '70.25' }],
      ),
    ).toEqual([{ assetId: asAssetId('USDT'), available: '70.25' }]);
  });
  it('keeps the larger figure when two sources disagree on one asset', () => {
    expect(
      heldAssets(
        [{ assetId: asAssetId('BTC'), available: '1', held: null, quantity: null }],
        [{ assetId: asAssetId('BTC'), balance: '2' }],
      ),
    ).toEqual([{ assetId: asAssetId('BTC'), available: '1' }]);
  });
  it('skips unreadable amounts instead of guessing', () => {
    expect(heldAssets([{ assetId: asAssetId('BTC'), available: 'abc', held: null, quantity: null }])).toEqual([]);
  });
  it('builds a pick list, never a free text box', () => {
    const field = assetSelectField('Asset', 'hint', [{ assetId: asAssetId('USDT'), available: '1' }]);
    expect(field.options).toEqual([{ value: 'USDT', label: 'USDT' }]);
  });
});

describe('named spaces added to the account quantity', () => {
  const holding = { assetId: asAssetId('USDT'), available: '500', held: '54.62', quantity: '554.62' };
  it('adds named spaces to the account quantity from the returned figures only', () => {
    const totals = spaceTotals(
      [
        { assetId: asAssetId('USDT'), balance: '400', kind: 'named' },
        { assetId: asAssetId('USDT'), balance: '70', kind: 'named' },
        { assetId: asAssetId('USDT'), balance: '554.62', kind: 'primary' },
      ],
      [holding],
    );
    expect(totals).toEqual([{ assetId: asAssetId('USDT'), inSpaces: '470', spaceCount: 2, accountQuantity: '554.62', total: '1024.62' }]);
  });
  it('gives no total when the bank did not return the account quantity', () => {
    const totals = spaceTotals([{ assetId: asAssetId('USDT'), balance: '470', kind: 'named' }], [{ ...holding, quantity: null }]);
    expect(totals[0]).toMatchObject({ inSpaces: '470', accountQuantity: null, total: null });
  });
  it('skips empty and unreadable spaces', () => {
    expect(
      spaceTotals(
        [
          { assetId: asAssetId('BTC'), balance: '0', kind: 'named' },
          { assetId: asAssetId('ETH'), balance: 'x', kind: 'named' },
        ],
        [],
      ),
    ).toEqual([]);
  });
});
