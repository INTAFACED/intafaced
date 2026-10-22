import { describe, expect, it } from 'vitest';
import { describeFraudPolicy, FRAUD_RULE_IDS } from '../fraud/fraud-policy.js';
import { createFounderAuthority } from '../founder-authority.js';
import { merchantRiskPolicy } from './merchant-disp-bill-rep-risk-policy.js';
import { createMerchantOpsRouter } from './router.js';

describe('M-disp-05 risk policy read', () => {
  const view = merchantRiskPolicy();

  it('lists exactly the rules fraud.policy names, in order, each in plain words (disputes-risk-028)', () => {
    expect(view.rules.map((r) => r.ruleId)).toEqual([...describeFraudPolicy().ruleIds]);
    expect(view.rules.map((r) => r.ruleId)).toEqual([...FRAUD_RULE_IDS]);
    for (const r of view.rules) {
      expect(r.title.length).toBeGreaterThan(3);
      expect(r.words).toMatch(/\.$/);
    }
  });

  it('publishes no number: every threshold is not set', () => {
    for (const r of view.rules) expect(r.threshold).toEqual({ state: 'not_set' });
    expect(JSON.stringify(view)).not.toMatch(/\d/);
  });

  it('says recorded, not enforced', () => {
    expect(view.enforcement).toBe('recorded_not_enforced');
  });

  it('every policy guarantee from fraud.policy is worded and currently holds', () => {
    const keys = Object.keys(describeFraudPolicy()).filter((k) => k !== 'ruleIds');
    expect(view.guarantees.map((g) => g.key).sort()).toEqual(keys.sort());
    for (const g of view.guarantees) expect(g.holds).toBe(true);
  });

  it('without a database the router refuses closed instead of answering', async () => {
    const founderAuthority = createFounderAuthority({ identityUrl: 'https://identity.invalid', serviceSecret: 's'.repeat(32) });
    const caller = createMerchantOpsRouter({ founderAuthority }).createCaller({
      principal: {
        userId: 'u1',
        sub: 'u1',
        sid: 's1',
        scopes: ['pay:read'],
        mfa: true,
        tier: 'full',
        expiresAt: new Date(Date.now() + 600_000),
      },
      service: null,
      region: 'DE',
      requestId: 'r1',
      forwardedPrincipal: { raw: 'p', signature: 's', region: 'DE' },
    } as never);
    await expect(caller.merchantOps.risk.policy({})).rejects.toMatchObject({ message: 'pay.merchant_ops_unavailable' });
  });
});
