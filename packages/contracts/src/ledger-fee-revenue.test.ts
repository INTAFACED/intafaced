import { describe, expect, it } from 'vitest';
import { ledgerFeeRevenueAssetSchema, ledgerFeeRevenueInputSchema, ledgerFeeRevenueSchema } from './ledger-fee-revenue.js';

describe('ledger fee revenue contract', () => {
  it('takes an ISO window and refuses a date-only value', () => {
    expect(ledgerFeeRevenueInputSchema.safeParse({ from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z' }).success).toBe(true);
    expect(ledgerFeeRevenueInputSchema.safeParse({ from: '2026-10-01', to: '2026-11-01' }).success).toBe(false);
  });

  it('carries amounts as decimal strings and allows a negative net', () => {
    expect(ledgerFeeRevenueAssetSchema.safeParse({ assetId: 'USDT', collected: '1.5', returned: '2', net: '-0.5' }).success).toBe(true);
    expect(
      ledgerFeeRevenueAssetSchema.safeParse({ assetId: 'USDT', collected: 1 as unknown as string, returned: '0', net: '1' }).success,
    ).toBe(false);
    expect(ledgerFeeRevenueAssetSchema.safeParse({ assetId: 'USDT', collected: '-1', returned: '0', net: '-1' }).success).toBe(false);
  });

  it('answers an empty window with no assets, not a zero row', () => {
    expect(ledgerFeeRevenueSchema.parse({ from: 'a', to: 'b', assets: [] }).assets).toEqual([]);
  });
});
