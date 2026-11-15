import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkMember,
  checkPlan,
  checkTerms,
  LAUNCH_PLAN_UNSET,
  type MemberInput,
  type PlanInput,
  type TermsInput,
} from './maker-programme-model';
import { memberPayloadHash, parseMarketPlans, parseTerms, planPayloadHash, termsPayloadHash } from './maker-programme-view';
import { memberDraft, planDraft, termsDraft } from './maker-programme-drafts';

const here = dirname(fileURLToPath(import.meta.url));

// The same TEST values and pinned hashes as svc-trade `src/admin/maker-programme-model.test.ts`.
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
const value = <T>(c: { ok: true; value: T } | { ok: false }) => {
  if (!c.ok) throw new Error('expected complete values');
  return c.value;
};

describe('maker programme in the console (J-cex-spot-20 #8)', () => {
  it('applies svc-trade’s own rule: this model is the same file, byte for byte', () => {
    const ours = readFileSync(join(here, 'maker-programme-model.ts'), 'utf8');
    const theirs = readFileSync(join(here, '../../../../../services/svc-trade/src/admin/maker-programme-model.ts'), 'utf8');
    expect(ours).toBe(theirs);
  });

  it('binds approvals to the same hashes svc-trade computes', () => {
    expect(termsPayloadHash('0', value(checkTerms(TERMS)))).toBe('sha256:aa0c932f6137a5a9d3397255f259d7f34079934ec98539e9647b9f2840507df0');
    expect(memberPayloadHash('0', value(checkMember(MEMBER)))).toBe(
      'sha256:41c72c4cc83e0438354db10af341d8e8d2a08437841abed9b83c2a40d3faee82',
    );
    expect(planPayloadHash(MARKET, '1', value(checkPlan(PLAN)))).toBe(
      'sha256:ccef949da9985ddb42c4f18ef275be2e1f7a0ea9ea422717155e74ffc4ef0d2b',
    );
  });

  it('reads drafts as sent, a blank kept blank, and nothing of another shape', () => {
    expect(planDraft({ ...PLAN, exitReviewDate: '' })).toMatchObject({ exitReviewDate: '' });
    expect(checkPlan(planDraft({ ...PLAN, exitReviewDate: '' })!)).toMatchObject({ code: LAUNCH_PLAN_UNSET });
    expect(planDraft({ ...PLAN, minDepth: 5 })).toBeNull();
    expect(termsDraft({ ...TERMS, tiers: 'x' })).toBeNull();
    expect(memberDraft({ ...MEMBER, status: 'other' })).toMatchObject({ status: null });
  });

  it('parses reads, and refuses another shape', () => {
    expect(parseTerms({ terms: null })).toEqual({ terms: null });
    expect(parseTerms({})).toBeNull();
    const stamp = { version: '1', operatorId: 'a', approverId: 'b', approvalId: 'x', writtenAt: 't' };
    expect(parseTerms({ terms: { ...TERMS, ...stamp } })?.terms?.version).toBe('1');
    const plan = { ...PLAN, ...stamp, market: MARKET, symbol: 'IFC/USDC', state: 'approved' };
    expect(parseMarketPlans({ markets: [{ market: MARKET, symbol: 'IFC/USDC', status: 'active', plan }] })).toHaveLength(1);
    expect(
      parseMarketPlans({ markets: [{ market: MARKET, symbol: 'IFC/USDC', status: 'active', plan: { ...plan, state: 'live' } }] }),
    ).toBeNull();
  });
});
