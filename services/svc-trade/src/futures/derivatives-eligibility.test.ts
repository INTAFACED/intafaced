/**
 * D-account-07 — derivatives eligibility with suitability. Hermetic: the memory store stands in for the tables.
 * Questions, answers, pass mark and tier below are TEST content; the real ones are the owner's.
 */
import { describe, expect, it } from 'vitest';
import {
  assertEligible,
  assessEligibility,
  ELIGIBILITY_ANSWERS_INVALID,
  ELIGIBILITY_SUBMISSION_CONFLICT,
  ELIGIBILITY_UNSET,
  IDENTITY_LEVEL_INSUFFICIENT,
  IDENTITY_LEVEL_UNAVAILABLE,
  memoryEligibilityStore,
  presentQuestions,
  readEligibilityState,
  validateEligibilityRules,
  type EligibilityRules,
  type EligibilityTier,
} from './derivatives-eligibility.js';
import { derivativesAccessGate } from './derivatives-access.js';
import { acceptAgreement, agreementTextId, memoryRiskAgreementStore } from './risk-agreements.js';

const USER = '11111111-1111-4111-8111-111111111111';
const AT = new Date('2026-10-20T10:00:00.000Z');

function rules(version: number, over: Partial<EligibilityRules> = {}): EligibilityRules {
  return {
    version,
    questions: [
      {
        id: 'q1',
        prompt: 'TEST question one',
        options: [
          { id: 'a', text: 'TEST a' },
          { id: 'b', text: 'TEST b' },
        ],
        correctOptionId: 'a',
      },
      {
        id: 'q2',
        prompt: 'TEST question two',
        options: [
          { id: 'a', text: 'TEST a' },
          { id: 'b', text: 'TEST b' },
        ],
        correctOptionId: 'b',
      },
    ],
    passMark: 2,
    minKycTier: 'basic',
    createdAt: AT,
    ...over,
  };
}

const PASS = { q1: 'a', q2: 'b' };
const FAIL = { q1: 'b', q2: 'a' };

describe('eligibility: blank rules refuse', () => {
  it('no published rules: the level cannot be granted and the open refuses trade.derivatives_eligibility_unset', async () => {
    const store = memoryEligibilityStore();
    await expect(assessEligibility(store, { userId: USER, submissionId: 's1', answers: PASS, now: AT })).rejects.toMatchObject({
      code: ELIGIBILITY_UNSET,
      status: 403,
      detail: { reason: 'rules_unpublished' },
    });
    await expect(assertEligible(store, { userId: USER, tier: 'full' })).rejects.toMatchObject({
      code: ELIGIBILITY_UNSET,
      detail: { reason: 'rules_unpublished' },
    });
    expect(await readEligibilityState(store, USER, 'full')).toMatchObject({
      status: 'unset',
      reason: 'rules_unpublished',
      ruleVersion: null,
    });
  });

  it('rule content must be complete: every blank part is refused at validation', () => {
    const base = { questions: rules(1).questions, passMark: 2, minKycTier: 'basic' };
    expect(validateEligibilityRules(base)).toEqual({ ok: true });
    const refused = (over: Record<string, unknown>) => validateEligibilityRules({ ...base, ...over } as never);
    expect(refused({ questions: [] })).toMatchObject({ ok: false });
    expect(refused({ passMark: 0 })).toMatchObject({ ok: false });
    expect(refused({ passMark: 3 })).toMatchObject({ ok: false });
    expect(refused({ passMark: 1.5 })).toMatchObject({ ok: false });
    expect(refused({ passMark: Number.NaN })).toMatchObject({ ok: false });
    expect(refused({ minKycTier: '' })).toMatchObject({ ok: false });
    expect(refused({ minKycTier: 'gold' })).toMatchObject({ ok: false });
    const q = rules(1).questions;
    expect(refused({ questions: [{ ...q[0]!, prompt: ' ' }] })).toMatchObject({ ok: false });
    expect(refused({ questions: [{ ...q[0]!, options: [q[0]!.options[0]!] }] })).toMatchObject({ ok: false });
    expect(refused({ questions: [{ ...q[0]!, correctOptionId: 'zzz' }] })).toMatchObject({ ok: false });
    expect(refused({ questions: [q[0]!, { ...q[1]!, id: 'q1' }] })).toMatchObject({ ok: false });
    expect(
      refused({
        questions: [
          {
            ...q[0]!,
            options: [
              { id: 'a', text: 'x' },
              { id: 'a', text: 'y' },
            ],
          },
        ],
      }),
    ).toMatchObject({ ok: false });
  });
});

describe('eligibility: assessment', () => {
  it('scores against the current rules; the customer wire never carries the scoring key', async () => {
    const store = memoryEligibilityStore();
    store.publish(rules(1));
    expect(JSON.stringify(presentQuestions(rules(1)))).not.toContain('correctOptionId');
    const failed = await assessEligibility(store, { userId: USER, submissionId: 's1', answers: FAIL, now: AT });
    expect(failed).toMatchObject({ ruleVersion: 1, score: 0, passMark: 2, passed: false, created: true });
    expect(await readEligibilityState(store, USER, 'full')).toMatchObject({ status: 'unset', reason: 'not_passed', lastScore: 0 });
    await expect(assertEligible(store, { userId: USER, tier: 'full' })).rejects.toMatchObject({
      code: ELIGIBILITY_UNSET,
      detail: { reason: 'not_passed' },
    });
    const passed = await assessEligibility(store, { userId: USER, submissionId: 's2', answers: PASS, now: AT });
    expect(passed).toMatchObject({ score: 2, passed: true, created: true });
    await expect(assertEligible(store, { userId: USER, tier: 'full' })).resolves.toBeUndefined();
    expect(await readEligibilityState(store, USER, 'full')).toMatchObject({ status: 'eligible', reason: null });
  });

  it('a user who never took the quiz is not_assessed', async () => {
    const store = memoryEligibilityStore();
    store.publish(rules(1));
    await expect(assertEligible(store, { userId: USER, tier: 'full' })).rejects.toMatchObject({
      code: ELIGIBILITY_UNSET,
      detail: { reason: 'not_assessed', ruleVersion: 1 },
    });
  });

  it('invalid answers refuse trade.eligibility_answers_invalid and store nothing', async () => {
    const store = memoryEligibilityStore();
    store.publish(rules(1));
    const bad: unknown[] = [null, [], 'a', { q1: 'a' }, { q1: 'a', q2: 'zzz' }, { q1: 'a', q2: 'b', q3: 'a' }, { q1: 1, q2: 'b' }];
    for (const answers of bad) {
      await expect(assessEligibility(store, { userId: USER, submissionId: 's', answers, now: AT })).rejects.toMatchObject({
        code: ELIGIBILITY_ANSWERS_INVALID,
        status: 400,
      });
    }
    for (const submissionId of [undefined, '', '   ', 'x'.repeat(65), 5]) {
      await expect(assessEligibility(store, { userId: USER, submissionId, answers: PASS, now: AT })).rejects.toMatchObject({
        code: ELIGIBILITY_ANSWERS_INVALID,
      });
    }
    expect(await store.latest(USER, 1)).toBeNull();
  });

  it('is idempotent on (user, submission id): a repeat returns the first result, other answers conflict', async () => {
    const store = memoryEligibilityStore();
    store.publish(rules(1));
    const first = await assessEligibility(store, { userId: USER, submissionId: 'retry-1', answers: PASS, now: AT });
    const again = await assessEligibility(store, {
      userId: USER,
      submissionId: 'retry-1',
      answers: PASS,
      now: new Date(AT.getTime() + 5000),
    });
    expect(first.created).toBe(true);
    expect(again).toMatchObject({ created: false, assessedAt: AT.toISOString(), passed: true });
    await expect(assessEligibility(store, { userId: USER, submissionId: 'retry-1', answers: FAIL, now: AT })).rejects.toMatchObject({
      code: ELIGIBILITY_SUBMISSION_CONFLICT,
      status: 409,
    });
  });

  it('a newer rule version makes an older pass stale until the user takes the new quiz', async () => {
    const store = memoryEligibilityStore();
    store.publish(rules(1));
    await assessEligibility(store, { userId: USER, submissionId: 's1', answers: PASS, now: AT });
    await expect(assertEligible(store, { userId: USER, tier: 'full' })).resolves.toBeUndefined();
    store.publish(rules(2, { passMark: 1 }));
    await expect(assertEligible(store, { userId: USER, tier: 'full' })).rejects.toMatchObject({
      code: ELIGIBILITY_UNSET,
      detail: { reason: 'rule_version_stale', ruleVersion: 2 },
    });
    const next = await assessEligibility(store, { userId: USER, submissionId: 's2', answers: { q1: 'a', q2: 'a' }, now: AT });
    expect(next).toMatchObject({ ruleVersion: 2, score: 1, passMark: 1, passed: true });
    await expect(assertEligible(store, { userId: USER, tier: 'full' })).resolves.toBeUndefined();
  });
});

describe('eligibility: verification tier', () => {
  async function eligibleUnder(minKycTier: EligibilityTier) {
    const store = memoryEligibilityStore();
    store.publish(rules(1, { minKycTier }));
    await assessEligibility(store, { userId: USER, submissionId: 's1', answers: PASS, now: AT });
    return store;
  }

  it('a known tier below the rule refuses trade.identity_level_insufficient with the required tier', async () => {
    const store = await eligibleUnder('full');
    await expect(assertEligible(store, { userId: USER, tier: 'basic' })).rejects.toMatchObject({
      code: IDENTITY_LEVEL_INSUFFICIENT,
      status: 403,
      detail: { requiredTier: 'full', currentTier: 'basic' },
    });
    await expect(assertEligible(store, { userId: USER, tier: 'none' })).rejects.toMatchObject({ code: IDENTITY_LEVEL_INSUFFICIENT });
    await expect(assertEligible(store, { userId: USER, tier: 'mystery' })).rejects.toMatchObject({ code: IDENTITY_LEVEL_INSUFFICIENT });
    await expect(assertEligible(store, { userId: USER, tier: 'full' })).resolves.toBeUndefined();
    await expect(assertEligible(store, { userId: USER, tier: 'institutional' })).resolves.toBeUndefined();
  });

  it('an unreadable tier refuses trade.identity_level_unavailable (named blocker, no vendor call)', async () => {
    const store = await eligibleUnder('basic');
    await expect(assertEligible(store, { userId: USER, tier: null })).rejects.toMatchObject({
      code: IDENTITY_LEVEL_UNAVAILABLE,
      status: 403,
      detail: { requiredTier: 'basic' },
    });
  });

  it('an owner who names tier none asks for no verification: the tier is not read', async () => {
    const store = await eligibleUnder('none');
    await expect(assertEligible(store, { userId: USER, tier: null })).resolves.toBeUndefined();
  });
});

describe('derivatives gate: agreements then eligibility, nothing configured refuses', () => {
  it('an empty deployment refuses on the agreement first, then on the eligibility, then admits', async () => {
    const agreements = memoryRiskAgreementStore();
    const eligibility = memoryEligibilityStore();
    const gate = derivativesAccessGate({ agreements, eligibility });
    const subject = { userId: USER, tier: 'full', region: 'DE' };
    await expect(gate(subject)).rejects.toMatchObject({ code: 'trade.agreement_unpublished' });

    agreements.publish({
      kind: 'derivatives_risk',
      version: 1,
      publishedAt: AT,
      texts: [{ region: 'DE', textId: agreementTextId('derivatives_risk', 1, 'DE'), title: 'TEST', body: 'TEST', bodySha256: 'sha256:t' }],
    });
    await expect(gate(subject)).rejects.toMatchObject({ code: 'trade.agreement_required' });
    await acceptAgreement(agreements, { userId: USER, kind: 'derivatives_risk', version: 1, region: 'DE', now: AT });
    await expect(gate(subject)).rejects.toMatchObject({ code: ELIGIBILITY_UNSET, detail: { reason: 'rules_unpublished' } });

    eligibility.publish(rules(1));
    await expect(gate(subject)).rejects.toMatchObject({ code: ELIGIBILITY_UNSET, detail: { reason: 'not_assessed' } });
    await assessEligibility(eligibility, { userId: USER, submissionId: 's1', answers: PASS, now: AT });
    await expect(gate(subject)).resolves.toBeUndefined();
    // the same user from a region with no text is refused again
    await expect(gate({ ...subject, region: 'FR' })).rejects.toMatchObject({ code: 'trade.agreement_region_unavailable' });
  });
});
