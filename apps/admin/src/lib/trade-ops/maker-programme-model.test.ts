import { describe, expect, it } from 'vitest';
import * as theirs from '../../../../../services/svc-trade/src/admin/maker-programme-model';
import * as ours from './maker-programme-model';
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

// Each field blank, padded, out of range or of the wrong form: the refusals both models give, and the values they bind.
const ODD: readonly (string | null)[] = [
  '',
  '   ',
  null,
  ' 7 ',
  '0',
  '0.0',
  '-1',
  '-2.5',
  '1.5',
  '1e3',
  '99.9999',
  '100',
  '100.0001',
  '101',
  '9999',
  '99999',
  '100000',
  'abc',
  'usdt',
  'USDT',
  '2027-02-29',
  '2028-02-29',
  '2027-13-01',
  '55555555-5555-4555-8555-55555555555A',
  ' 55555555-5555-4555-8555-555555555555 ',
  'active',
  'other',
  'x'.repeat(41),
  'x'.repeat(2001),
];
function* each<T extends object>(base: T): Generator<T> {
  for (const key of Object.keys(base)) {
    if (typeof (base as Record<string, unknown>)[key] !== 'string') continue;
    for (const odd of ODD) yield { ...base, [key]: odd };
  }
}
function* termsCases(): Generator<TermsInput> {
  yield TERMS;
  yield { ...TERMS, tiers: [] };
  yield { ...TERMS, tiers: [TERMS.tiers[0]!, { ...TERMS.tiers[0]!, name: 'test gold' }] };
  yield { ...TERMS, tiers: Array.from({ length: 11 }, (_, i) => ({ ...TERMS.tiers[0]!, name: `TEST ${i}` })) };
  yield* each(TERMS);
  for (const tier of each(TERMS.tiers[0]!)) yield { ...TERMS, tiers: [tier] };
}
function* memberCases(): Generator<MemberInput> {
  yield MEMBER;
  yield* each(MEMBER);
  for (const status of ['suspended', 'exited', null, 'other']) yield { ...MEMBER, status: status as MemberInput['status'] };
}
function* planCases(): Generator<PlanInput> {
  yield PLAN;
  yield { ...PLAN, makers: [] };
  yield { ...PLAN, makers: [PLAN.makers[0]!, PLAN.makers[0]!] };
  yield {
    ...PLAN,
    makers: Array.from({ length: 21 }, (_, i) => ({
      ...PLAN.makers[0]!,
      accountId: `55555555-5555-4555-8555-5555555555${String(i).padStart(2, '0')}`,
    })),
  };
  yield* each(PLAN);
  for (const maker of each(PLAN.makers[0]!)) yield { ...PLAN, makers: [maker] };
}

describe('maker programme in the console (J-cex-spot-20 #8)', () => {
  it('applies svc-trade’s own rule: the same exports, codes and answer for every input', () => {
    expect(Object.keys(ours).sort()).toEqual(Object.keys(theirs).sort());
    for (const [name, v] of Object.entries(theirs))
      if (typeof v !== 'function') expect((ours as Record<string, unknown>)[name], name).toEqual(v);
    const same = <T>(check: (o: typeof ours, input: T) => unknown, input: T, what: string) =>
      expect(check(ours, input), what).toEqual(check(theirs, input));
    for (const input of termsCases()) same((m, i) => m.checkTerms(i), input, JSON.stringify(input));
    for (const input of memberCases()) same((m, i) => m.checkMember(i), input, JSON.stringify(input));
    for (const input of planCases()) same((m, i) => m.checkPlan(i), input, JSON.stringify(input));
    same((m, i) => m.termsApprovalBody('3', i), TERMS, 'terms body');
    same((m, i) => m.memberApprovalBody('3', i), MEMBER, 'member body');
    same((m, i) => m.planApprovalBody(MARKET, '3', i), PLAN, 'plan body');
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
