import { describe, expect, it } from 'vitest';
import { payloadHash } from './common.js';
import {
  checkMember,
  checkPlan,
  checkTerms,
  LAUNCH_PLAN_INVALID,
  LAUNCH_PLAN_UNSET,
  MAKER_PROGRAMME_MEMBER_UNSET,
  MAKER_PROGRAMME_TERM_INVALID,
  MAKER_PROGRAMME_TERM_UNSET,
  memberApprovalBody,
  planApprovalBody,
  termsApprovalBody,
  type MemberInput,
  type PlanInput,
  type TermsInput,
} from './maker-programme-model.js';

// The same TEST values, and the same pinned hashes, as apps/admin `maker-programme-model.test.ts`.
const TERMS: TermsInput = {
  tiers: [{ name: 'TEST Gold', minMakerVolume30d: '1000000', minUptimePct: '97.5', maxSpreadAtDepthBps: '20', rebateBps: '3' }],
  maxSpreadBps: '50',
  minDepth: '25000',
  minUptimePct: '95',
  cancelToFillCeiling: '30',
  clawbackWindowDays: '90',
  equalAccessCriteria: 'TEST criteria',
};
const MEMBER: MemberInput = {
  accountId: '55555555-5555-4555-8555-555555555555',
  tier: 'TEST Gold',
  status: 'active',
  conflictDeclaration: 'TEST: none',
};
const PLAN: PlanInput = {
  makers: [{ accountId: '55555555-5555-4555-8555-555555555555', capital: '50000', asset: 'usdt' }],
  maxSpreadBps: '30',
  minDepth: '10000',
  depthBandBps: '50',
  minUptimePct: '95',
  inventoryMin: '-2.5',
  inventoryMax: '2.5',
  exitReviewDate: '2027-02-01',
  exitUptimeBelowPct: '80',
  exitSpreadAboveBps: '100',
};
const MARKET = '0b6c3d0e-9f1a-4c2b-8d3e-112233445566';
const PINNED = {
  terms: 'sha256:aa0c932f6137a5a9d3397255f259d7f34079934ec98539e9647b9f2840507df0',
  member: 'sha256:41c72c4cc83e0438354db10af341d8e8d2a08437841abed9b83c2a40d3faee82',
  plan: 'sha256:ccef949da9985ddb42c4f18ef275be2e1f7a0ea9ea422717155e74ffc4ef0d2b',
};

const value = <T>(c: { ok: true; value: T } | { ok: false }) => {
  if (!c.ok) throw new Error('expected complete values');
  return c.value;
};

describe('maker programme and launch-liquidity values (J-cex-spot-20 #8)', () => {
  it('refuses a blank term by name, and checks the rest', () => {
    expect(checkTerms({ ...TERMS, tiers: [] })).toMatchObject({
      ok: false,
      code: MAKER_PROGRAMME_TERM_UNSET,
      message: expect.stringContaining('tiers'),
    });
    expect(checkTerms({ ...TERMS, tiers: [{ ...TERMS.tiers[0]!, rebateBps: ' ' }] })).toMatchObject({
      code: MAKER_PROGRAMME_TERM_UNSET,
      message: expect.stringContaining('tier 1 rebate'),
    });
    for (const [key, name] of [
      ['maxSpreadBps', 'max spread'],
      ['minDepth', 'min depth'],
      ['minUptimePct', 'min uptime'],
      ['cancelToFillCeiling', 'cancel-to-fill ceiling'],
      ['clawbackWindowDays', 'clawback window'],
      ['equalAccessCriteria', 'equal-access criteria'],
    ] as const) {
      expect(checkTerms({ ...TERMS, [key]: null })).toMatchObject({
        code: MAKER_PROGRAMME_TERM_UNSET,
        message: expect.stringContaining(name),
      });
    }
    expect(checkTerms({ ...TERMS, minUptimePct: '100.5' })).toMatchObject({ code: MAKER_PROGRAMME_TERM_INVALID });
    expect(checkTerms({ ...TERMS, minDepth: '0' })).toMatchObject({ code: MAKER_PROGRAMME_TERM_INVALID });
    expect(checkTerms({ ...TERMS, tiers: [TERMS.tiers[0]!, { ...TERMS.tiers[0]!, name: 'test gold' }] })).toMatchObject({
      code: MAKER_PROGRAMME_TERM_INVALID,
    });
    expect(value(checkTerms({ ...TERMS, maxSpreadBps: ' 50 ' })).maxSpreadBps).toBe('50');
  });

  it('refuses a blank member field by name', () => {
    expect(checkMember({ ...MEMBER, conflictDeclaration: '' })).toMatchObject({ code: MAKER_PROGRAMME_MEMBER_UNSET });
    expect(checkMember({ ...MEMBER, status: null })).toMatchObject({ message: 'status is not set' });
    expect(value(checkMember({ ...MEMBER, accountId: MEMBER.accountId!.toUpperCase() })).accountId).toBe(MEMBER.accountId);
  });

  it('refuses a blank plan field by name, exit criteria included', () => {
    expect(checkPlan({ ...PLAN, makers: [] })).toMatchObject({ code: LAUNCH_PLAN_UNSET, message: expect.stringContaining('makers') });
    expect(checkPlan({ ...PLAN, exitReviewDate: '' })).toMatchObject({
      code: LAUNCH_PLAN_UNSET,
      message: expect.stringContaining('exit criteria: review date'),
    });
    expect(checkPlan({ ...PLAN, makers: [{ ...PLAN.makers[0]!, capital: null }] })).toMatchObject({
      message: expect.stringContaining('maker 1 capital'),
    });
    expect(checkPlan({ ...PLAN, inventoryMin: '3x' })).toMatchObject({ code: LAUNCH_PLAN_INVALID });
    expect(checkPlan({ ...PLAN, exitReviewDate: '2027-02-30' })).toMatchObject({ code: LAUNCH_PLAN_INVALID });
    expect(value(checkPlan(PLAN)).makers[0]!.asset).toBe('USDT');
  });

  it('pins the approval hashes the console computes', () => {
    expect(payloadHash(termsApprovalBody('0', value(checkTerms(TERMS))))).toBe(PINNED.terms);
    expect(payloadHash(memberApprovalBody('0', value(checkMember(MEMBER))))).toBe(PINNED.member);
    expect(payloadHash(planApprovalBody(MARKET, '1', value(checkPlan(PLAN))))).toBe(PINNED.plan);
  });
});
