import { describe, expect, it } from 'vitest';
import { merchantTierListSchema, type MerchantTierList } from '@intafaced/contracts';
import { pricingVisibilityFor, TEAM_ROLES, type MerchantRole } from './merchant-ops/roles.js';
import { projectTierList } from './team-read-projection.js';

/** TEST VALUE ladder: one tier with a spread, one fee with no spread configured. */
const ladder: MerchantTierList = {
  status: 'configured',
  ownTierId: 'test-tier',
  tiers: [
    {
      id: 'test-tier',
      name: 'TEST VALUE',
      archetype: 'standard',
      caps: [{ kind: 'beneficiaries_per_day', limit: 1 }],
      reserve: null,
      fees: [
        {
          assetCode: 'USDT',
          bands: [{ fromAmount: '0', feeBps: 250, flatFee: null }],
          spreadBps: 35,
          roundingBeneficiary: 'platform',
          minFee: null,
          maxFee: null,
          version: '1',
        },
        {
          assetCode: 'USDC',
          bands: [{ fromAmount: '0', feeBps: 200, flatFee: null }],
          spreadBps: null,
          roundingBeneficiary: 'platform',
          minFee: null,
          maxFee: null,
          version: '1',
        },
      ],
      payoutFee: { kind: 'not_charged' },
      version: '1',
    },
  ],
};

describe('projectTierList', () => {
  const roles: MerchantRole[] = ['owner', ...TEAM_ROLES];

  it('follows the same rule as pricingVisibility for every role, and the result still parses as the contract', () => {
    for (const role of roles) {
      const projected = projectTierList(ladder, role);
      expect(merchantTierListSchema.safeParse(projected).success).toBe(true);
      if (projected.status !== 'configured') throw new Error('expected the ladder');
      const fees = projected.tiers[0]!.fees;
      if (pricingVisibilityFor(role) === 'full') {
        expect(projected).toEqual(ladder);
      } else {
        expect(fees).toHaveLength(2);
        for (const fee of fees) expect(fee).not.toHaveProperty('spreadBps');
        expect(fees[0]).toMatchObject({ assetCode: 'USDT', bands: [{ fromAmount: '0', feeBps: 250, flatFee: null }] });
      }
    }
  });

  it('owner, admin and finance keep spreadBps; viewer and developer lose it', () => {
    const spreadOf = (role: MerchantRole) => {
      const projected = projectTierList(ladder, role);
      return projected.status === 'configured' ? projected.tiers[0]!.fees.map((fee) => fee.spreadBps) : null;
    };
    expect(spreadOf('owner')).toEqual([35, null]);
    expect(spreadOf('admin')).toEqual([35, null]);
    expect(spreadOf('finance')).toEqual([35, null]);
    expect(spreadOf('viewer')).toEqual([undefined, undefined]);
    expect(spreadOf('developer')).toEqual([undefined, undefined]);
  });

  it('a caller with no role gets no spread, and not_configured passes through unchanged', () => {
    const projected = projectTierList(ladder, null);
    expect(JSON.stringify(projected)).not.toContain('spreadBps');
    const empty: MerchantTierList = { status: 'not_configured', ownTierId: null };
    expect(projectTierList(empty, 'viewer')).toEqual(empty);
  });

  it('does not change the list it was given', () => {
    const before = JSON.stringify(ladder);
    projectTierList(ladder, 'viewer');
    expect(JSON.stringify(ladder)).toBe(before);
  });
});
