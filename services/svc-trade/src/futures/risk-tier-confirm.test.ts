import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import { readConfirmTier, tierCrossing, unconfirmedTierRefusal } from './risk-tier-confirm.js';

const A = (s: string) => parseAmount(s);
// Depth 1,000: tier 1 up to 50 of notional, tier 2 up to 200, tier 3 the rest.
const POLICY = {
  tiers: [
    { uptoDepthBps: 500, maintenanceBps: 50 },
    { uptoDepthBps: 2_000, maintenanceBps: 100 },
    { uptoDepthBps: Number.MAX_SAFE_INTEGER, maintenanceBps: 500 },
  ],
  marginCallBps: 12_000,
  targetBps: 15_000,
  maxTrancheBps: 2_500,
};
const at = (exposure: string, qty: string) =>
  tierCrossing({ policy: POLICY, depthNotional: A('1000'), mark: A('100'), exposure: A(exposure), qty: A(qty) });

describe('the margin tier an order carries a side into', () => {
  it('a first order inside tier 1 asks nothing; one past it asks for the tier it opens in', () => {
    expect(at('0', '0.5')).toEqual({
      currentTier: null,
      projectedTier: 1,
      maintenanceBps: 50,
      notional: A('50'),
      confirmRequired: false,
      tiers: 3,
      depthNotional: A('1000'),
    });
    expect(at('0', '0.51')).toMatchObject({ currentTier: null, projectedTier: 2, maintenanceBps: 100, confirmRequired: true });
  });

  it('the boundary is rated into the higher tier, as the ladder rates it', () => {
    // 50.0001 of notional is 500.001 bps of depth, rounded up past tier 1's bound.
    expect(at('0.5', '0.000001').projectedTier).toBe(2);
    expect(at('0.25', '0.25').projectedTier).toBe(1);
  });

  it('adding inside the tier the side already sits in asks nothing; crossing out of it asks', () => {
    expect(at('1', '0.5')).toMatchObject({ currentTier: 2, projectedTier: 2, confirmRequired: false });
    expect(at('1', '1.5')).toMatchObject({ currentTier: 2, projectedTier: 3, maintenanceBps: 500, confirmRequired: true });
  });

  it('the refusal names the tier, its maintenance and the leverage, and a confirm for that tier or above clears it', () => {
    const crossing = at('0.4', '0.4');
    expect(unconfirmedTierRefusal(crossing, undefined, A('5'), A('20'))).toEqual({
      code: 'trade.risk_limit_confirm_required',
      status: 409,
      message:
        'this order moves the position from tier 1 into tier 2 (maintenance 1.00%) at 5x leverage; every tier answers to the listing cap of 20x. Send confirmTier 2 to place it',
    });
    expect(unconfirmedTierRefusal(crossing, 1, A('5'), A('20'))?.code).toBe('trade.risk_limit_confirm_required');
    expect(unconfirmedTierRefusal(crossing, 2, A('5'), A('20'))).toBeNull();
    expect(unconfirmedTierRefusal(crossing, 3, A('5'), A('20'))).toBeNull();
    expect(unconfirmedTierRefusal(at('0', '3'), undefined, A('2.5'), null)?.message).toBe(
      'this order opens the position in tier 3 (maintenance 5.00%) at 2.5x leverage; the listing cap is unset. Send confirmTier 3 to place it',
    );
    expect(unconfirmedTierRefusal(at('0', '0.1'), undefined, A('5'), A('20'))).toBeNull();
  });

  it('a confirmTier above the last published tier names no tier: refused, never a waiver of every crossing', () => {
    for (const crossing of [at('0', '0.1'), at('0', '3')]) {
      expect(unconfirmedTierRefusal(crossing, 4, A('5'), A('20'))).toEqual({
        code: 'trade.confirm_tier_invalid',
        status: 400,
        message: 'confirmTier 4 names no published tier; the ladder has 3',
      });
    }
    expect(unconfirmedTierRefusal(at('0', '3'), 3, A('5'), A('20'))).toBeNull();
  });

  it('confirmTier is absent or a whole number from 1', () => {
    expect(readConfirmTier(undefined)).toEqual({ ok: true, tier: undefined });
    expect(readConfirmTier(3)).toEqual({ ok: true, tier: 3 });
    for (const bad of [0, -1, 1.5, '2', null, Number.NaN, 2 ** 60]) expect(readConfirmTier(bad)).toEqual({ ok: false });
  });
});
