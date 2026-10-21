import { describe, expect, it } from 'vitest';
import {
  OPS_COST_CATEGORIES,
  opsCostAmountSchema,
  opsCostEntrySchema,
  opsCostPeriodSchema,
  opsVenueEconomicsSchema,
} from './ops-venue-economics.js';

describe('venue economics contract', () => {
  it('lists the seven spec categories', () => {
    expect(OPS_COST_CATEGORIES).toEqual([
      'liquidity',
      'insurance_default_capital',
      'custody',
      'data',
      'support',
      'compliance',
      'infrastructure',
    ]);
  });

  it('accepts non-negative decimal strings only', () => {
    expect(opsCostAmountSchema.safeParse('12.5').success).toBe(true);
    expect(opsCostAmountSchema.safeParse('-1').success).toBe(false);
    expect(opsCostAmountSchema.safeParse(12 as unknown as string).success).toBe(false);
    expect(opsCostAmountSchema.safeParse('1.1234567890123456789').success).toBe(false);
  });

  it('accepts a month period only', () => {
    expect(opsCostPeriodSchema.safeParse('2026-10').success).toBe(true);
    expect(opsCostPeriodSchema.safeParse('2026-13').success).toBe(false);
    expect(opsCostPeriodSchema.safeParse('2026').success).toBe(false);
  });

  it('round-trips an entry and an incomplete report', () => {
    const entry = {
      key: 'venue-cost:2026-10:custody:1',
      period: '2026-10',
      category: 'custody',
      version: 1,
      amount: '10',
      asset: 'USD',
      sourceNote: 'TEST invoice',
      enteredBy: 'u1',
      approverId: 'u2',
      enteredAt: '2026-10-20T00:00:00.000Z',
    };
    expect(opsCostEntrySchema.parse(entry)).toEqual(entry);
    const report = {
      asOf: '2026-10-20T00:00:00.000Z',
      period: '2026-10',
      revenue: { status: 'unavailable', code: 'ops.warehouse_unwired', message: 'x' },
      costs: [{ status: 'not_entered', category: 'data' }],
      completeness: { status: 'incomplete', missing: ['data'] },
      costTotals: { partial: true, byAsset: [] },
      net: { status: 'unavailable', reason: 'revenue_asset_unknown' },
    };
    expect(opsVenueEconomicsSchema.parse(report)).toEqual(report);
  });

  it('accepts a net by asset and a ledger fee revenue block, and refuses a number', () => {
    const base = {
      asOf: '2026-11-02T00:00:00Z',
      period: '2026-10',
      revenue: { status: 'unavailable', code: 'ops.warehouse_unwired', message: 'x' },
      costs: [],
      completeness: { status: 'complete' },
      costTotals: { partial: false, byAsset: [] },
    };
    const ok = {
      ...base,
      feeRevenue: { status: 'ok', assets: [{ assetId: 'USDT', collected: '12.5', returned: '0.5', net: '12' }] },
      net: { status: 'ok', byAsset: [{ asset: 'USDT', revenue: '12', costs: '15', net: '-3' }] },
    };
    expect(opsVenueEconomicsSchema.safeParse(ok).success).toBe(true);
    expect(opsVenueEconomicsSchema.safeParse({ ...base, net: { status: 'unavailable', reason: 'costs_incomplete' } }).success).toBe(true);
    expect(
      opsVenueEconomicsSchema.safeParse({ ...ok, net: { status: 'ok', byAsset: [{ asset: 'USDT', revenue: 12, costs: '1', net: '11' }] } })
        .success,
    ).toBe(false);
    expect(opsVenueEconomicsSchema.safeParse({ ...base, net: { status: 'unavailable', reason: 'guess' } }).success).toBe(false);
  });
});
