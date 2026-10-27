/**
 * D-account-07 — the identity level a futures open needs. Hermetic: the memory store stands in for the rules table.
 * The suitability quiz no longer gates an open (owner decision 2026-10-27); the rules still name the tier.
 * Questions, pass mark and tier below are TEST content; the real ones are the owner's.
 */
import { describe, expect, it } from 'vitest';
import {
  assertIdentityLevel,
  IDENTITY_LEVEL_INSUFFICIENT,
  IDENTITY_LEVEL_UNAVAILABLE,
  IDENTITY_LEVEL_UNSET,
  memoryEligibilityStore,
  validateEligibilityRules,
  type EligibilityRules,
  type EligibilityStore,
  type EligibilityTier,
} from './derivatives-eligibility.js';
import { derivativesAccessGate } from './derivatives-access.js';

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

describe('eligibility rules: operator content', () => {
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

describe('identity level', () => {
  function under(minKycTier: EligibilityTier) {
    const store = memoryEligibilityStore();
    store.publish(rules(1, { minKycTier }));
    return store;
  }

  it('no published rules: the blank tier refuses every caller trade.identity_level_unset, never "no requirement"', async () => {
    const store = memoryEligibilityStore();
    for (const tier of ['none', 'institutional', null]) {
      await expect(assertIdentityLevel(store, { userId: USER, tier })).rejects.toMatchObject({
        code: IDENTITY_LEVEL_UNSET,
        status: 403,
        detail: { requiredTier: null },
      });
    }
  });

  it('no quiz is asked for: a caller at the rule tier passes without any assessment', async () => {
    await expect(assertIdentityLevel(under('full'), { userId: USER, tier: 'full' })).resolves.toBeUndefined();
  });

  it('a known tier below the rule refuses trade.identity_level_insufficient with the required tier', async () => {
    const store = under('full');
    await expect(assertIdentityLevel(store, { userId: USER, tier: 'basic' })).rejects.toMatchObject({
      code: IDENTITY_LEVEL_INSUFFICIENT,
      status: 403,
      detail: { requiredTier: 'full', currentTier: 'basic' },
    });
    await expect(assertIdentityLevel(store, { userId: USER, tier: 'none' })).rejects.toMatchObject({ code: IDENTITY_LEVEL_INSUFFICIENT });
    await expect(assertIdentityLevel(store, { userId: USER, tier: 'mystery' })).rejects.toMatchObject({
      code: IDENTITY_LEVEL_INSUFFICIENT,
    });
    await expect(assertIdentityLevel(store, { userId: USER, tier: 'full' })).resolves.toBeUndefined();
    await expect(assertIdentityLevel(store, { userId: USER, tier: 'institutional' })).resolves.toBeUndefined();
  });

  it('an unreadable tier refuses trade.identity_level_unavailable (named blocker, no vendor call)', async () => {
    await expect(assertIdentityLevel(under('basic'), { userId: USER, tier: null })).rejects.toMatchObject({
      code: IDENTITY_LEVEL_UNAVAILABLE,
      status: 403,
      detail: { requiredTier: 'basic' },
    });
  });

  it('an owner who names tier none asks for no verification: the tier is not read', async () => {
    await expect(assertIdentityLevel(under('none'), { userId: USER, tier: null })).resolves.toBeUndefined();
  });

  it('the newest rule version names the tier', async () => {
    const store = under('basic');
    store.publish(rules(2, { minKycTier: 'institutional' }));
    await expect(assertIdentityLevel(store, { userId: USER, tier: 'full' })).rejects.toMatchObject({
      code: IDENTITY_LEVEL_INSUFFICIENT,
      detail: { requiredTier: 'institutional' },
    });
  });

  it('a rules read that fails refuses the open rather than skip the tier', async () => {
    const broken: EligibilityStore = {
      currentRules: async () => {
        throw new Error('connection reset');
      },
    };
    await expect(assertIdentityLevel(broken, { userId: USER, tier: 'full' })).rejects.toThrow('connection reset');
  });
});

describe('derivatives gate: the identity level only', () => {
  it('an empty deployment refuses on the blank tier; once published, the tier is the only thing that refuses', async () => {
    const eligibility = memoryEligibilityStore();
    const gate = derivativesAccessGate({ eligibility });
    const subject = { userId: USER, tier: 'basic', region: 'FR' };
    await expect(gate(subject)).rejects.toMatchObject({ code: IDENTITY_LEVEL_UNSET });
    eligibility.publish(rules(1, { minKycTier: 'basic' }));
    await expect(gate(subject)).resolves.toBeUndefined();
    eligibility.publish(rules(2, { minKycTier: 'full' }));
    await expect(gate(subject)).rejects.toMatchObject({ code: IDENTITY_LEVEL_INSUFFICIENT });
    await expect(gate({ ...subject, tier: 'full' })).resolves.toBeUndefined();
  });
});
