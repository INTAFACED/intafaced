import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import { KYC_TIERS, checkAccess, tierSatisfies } from '@intafaced/config';
import { KYC_LADDER_FEATURES, KYC_LADDER_LEVELS, kycLevelsDescribeOutputSchema } from '@intafaced/contracts/identity-kyc-levels';
import {
  EMPTY_KYC_LADDER_SETTINGS,
  KYC_FEATURE_GUARDS,
  describeLevels,
  featureAt,
  parseKycRequirementsByLevel,
  parseKycReviewHoursByLevel,
} from './levels.js';
import { createKycLevelsRouter } from './levels-router.js';

const FAIL_CLOSED = 'INTAFACED_SCREENING_FAIL_CLOSED';
const SAVED_KEYS = [FAIL_CLOSED, 'APP_ENV'] as const;
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(SAVED_KEYS.map((k) => [k, process.env[k]]));
  // The honesty-only path (honoured only under APP_ENV test): these tests are about the ladder, not the screening list.
  process.env[FAIL_CLOSED] = 'off';
  process.env.APP_ENV = 'test';
});
afterEach(() => {
  for (const k of SAVED_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const ladder = (held: (typeof KYC_TIERS)[number], region = 'DE', settings = EMPTY_KYC_LADDER_SETTINGS) =>
  describeLevels({ held, region, regionResolved: region !== 'XX', settings });

describe('kyc.levels.describe: the ladder (I-kyc-compliance-04)', () => {
  it('the contract lists the same levels, in the same order, as the matrix', () => {
    expect([...KYC_LADDER_LEVELS]).toEqual([...KYC_TIERS]);
  });

  it('at level none every gated feature says which level unlocks it', () => {
    const none = ladder('none').levels[0]!;
    expect(none.current).toBe(true);
    expect(Object.fromEntries(none.features.map((f) => [f.feature, f.state === 'needs_level' ? f.level : f.state]))).toEqual({
      deposit: 'full',
      withdraw: 'basic',
      trade: 'basic',
      card: 'full',
      earn: 'full',
      rewards: 'allowed',
    });
    expect(none.features.find((f) => f.feature === 'rewards')?.perOffer).toBe(true);
  });

  it('each feature at each level is what its guard decides, for every region the matrix names and the unresolved one', () => {
    for (const region of ['DE', 'GB', 'US', 'XX']) {
      for (const level of KYC_TIERS) {
        for (const feature of KYC_LADDER_FEATURES) {
          const guard = KYC_FEATURE_GUARDS[feature];
          const decision = checkAccess({ module: guard.module, plane: 'fiat', region, kycTier: level });
          const served = decision.allowed && tierSatisfies(level, guard.floor ?? 'none');
          const got = featureAt(feature, level, region);
          expect(got.state === 'allowed', `${feature} ${level} ${region}`).toBe(served);
          if (got.state === 'needs_level') {
            // The level named really serves it, and nothing below it does.
            const unlocked = checkAccess({ module: guard.module, plane: 'fiat', region, kycTier: got.level });
            expect(unlocked.allowed && tierSatisfies(got.level, guard.floor ?? 'none')).toBe(true);
            expect(tierSatisfies(level, got.level)).toBe(false);
          }
          if (got.state === 'blocked') expect(got.code).toBe(decision.code);
        }
      }
    }
  });

  it('a region where trade needs more than the floor names that level; a module the region does not offer is blocked at every level', () => {
    const gb = ladder('basic', 'GB').levels.find((r) => r.level === 'basic')!;
    expect(gb.features.find((f) => f.feature === 'trade')).toEqual({
      feature: 'trade',
      state: 'needs_level',
      level: 'full',
      perOffer: false,
    });
    for (const rung of ladder('institutional', 'US').levels) {
      expect(rung.features.find((f) => f.feature === 'card')).toEqual({
        feature: 'card',
        state: 'blocked',
        code: 'denied.module_blocked',
        perOffer: false,
      });
    }
  });

  it('with the screening list unset and fail-closed on, every feature reads blocked, never allowed', () => {
    process.env[FAIL_CLOSED] = 'on';
    const prior = process.env.INTAFACED_SANCTIONS_REGIONS;
    delete process.env.INTAFACED_SANCTIONS_REGIONS;
    try {
      for (const rung of ladder('institutional').levels)
        for (const f of rung.features) expect(f).toMatchObject({ state: 'blocked', code: 'denied.screening_unconfigured' });
    } finally {
      if (prior !== undefined) process.env.INTAFACED_SANCTIONS_REGIONS = prior;
    }
  });

  it('the held level is the one current rung, and the output passes the contract', () => {
    for (const held of KYC_TIERS) {
      const out = ladder(held);
      expect(out.levels.filter((r) => r.current).map((r) => r.level)).toEqual([held]);
      expect(kycLevelsDescribeOutputSchema.safeParse(out).success).toBe(true);
    }
  });
});

describe('published requirements and review times (I-kyc-compliance-05)', () => {
  it('unset: every level is unpublished with no review time, never an empty list', () => {
    for (const rung of ladder('none').levels) {
      expect(rung.requirements).toEqual({ published: false });
      expect(rung.reviewHours).toBeNull();
    }
  });

  it("published: a level shows the owner's list and stated time; levels left out stay unpublished", () => {
    const settings = {
      requirements: parseKycRequirementsByLevel('{"basic":["legal_name","date_of_birth","id_document"]}'),
      reviewHours: parseKycReviewHoursByLevel('basic=24, full=72'),
    };
    const out = ladder('none', 'DE', settings);
    const at = (level: string) => out.levels.find((r) => r.level === level)!;
    expect(at('basic').requirements).toEqual({ published: true, keys: ['legal_name', 'date_of_birth', 'id_document'] });
    expect(at('basic').reviewHours).toBe(24);
    expect(at('full').requirements).toEqual({ published: false });
    expect(at('full').reviewHours).toBe(72);
    expect(at('institutional').reviewHours).toBeNull();
  });

  it('blank settings parse to nothing published', () => {
    expect(parseKycRequirementsByLevel(undefined).size).toBe(0);
    expect(parseKycRequirementsByLevel('  ').size).toBe(0);
    expect(parseKycReviewHoursByLevel(undefined).size).toBe(0);
    expect(parseKycReviewHoursByLevel('').size).toBe(0);
  });

  it.each([
    ['not json', 'JSON object'],
    ['[]', 'JSON object'],
    ['{"basic":[]}', 'at least one'],
    ['{"basic":"id_document"}', 'at least one'],
    ['{"gold":["id_document"]}', 'not a verification level'],
    ['{"basic":["blood_type"]}', 'unknown requirement'],
    ['{"basic":["id_document","id_document"]}', 'twice'],
    ['{"basic":["legal_name"],"basic":["email"]}', 'basic is set twice'],
  ])('a malformed requirement list stops the service: %s', (raw, message) => {
    expect(() => parseKycRequirementsByLevel(raw)).toThrow(message);
  });

  it.each([
    ['basic', 'level=hours'],
    ['basic=24=1', 'level=hours'],
    ['gold=24', 'not a verification level'],
    ['basic=0', '1 to 8760'],
    ['basic=8761', '1 to 8760'],
    ['basic=1.5', 'whole hours'],
    ['basic=24,basic=48', 'twice'],
  ])('a malformed review time stops the service: %s', (raw, message) => {
    expect(() => parseKycReviewHoursByLevel(raw)).toThrow(message);
  });
});

describe('the read door', () => {
  const authConfig = {
    secret: 'an-identity-router-test-secret-long-enough',
    issuer: 'intafaced',
    audience: 'intafaced.api',
    accessTtlSeconds: 900,
  };
  const ME = '11111111-1111-4111-8111-111111111111';
  const SID = '44444444-4444-4444-8444-444444444444';
  async function caller(scopes: string[], region = 'GB') {
    const { token } = await issueAccessToken({ userId: ME, sessionId: SID, scopes: scopes as never, tier: 'none', mfa: false }, authConfig);
    const ctx = { principal: await verifyAccessToken(token, authConfig), service: null, region, requestId: 'r' };
    const asked: string[] = [];
    const r = createKycLevelsRouter({
      kycTier: async (userId) => {
        asked.push(userId);
        return 'basic';
      },
      settings: EMPTY_KYC_LADDER_SETTINGS,
    }).createCaller(ctx as never);
    return { r, asked };
  }

  it("reads the caller's own level from identity, for the edge's region", async () => {
    const { r, asked } = await caller(['identity:read']);
    const out = await r.describe();
    expect(asked).toEqual([ME]);
    expect(out).toMatchObject({ held: 'basic', region: 'GB', regionResolved: true });
    expect(out.levels.find((l) => l.current)?.level).toBe('basic');
  });

  it('says when the region was never resolved', async () => {
    const { r } = await caller(['identity:read'], 'XX');
    expect(await r.describe()).toMatchObject({ region: 'XX', regionResolved: false });
  });

  it('a blank region reads as unresolved, never as a broken read', async () => {
    const { r } = await caller(['identity:read'], '');
    expect(await r.describe()).toMatchObject({ region: 'XX', regionResolved: false });
  });

  it('refuses a caller without identity:read', async () => {
    const { r, asked } = await caller(['trade:read']);
    await expect(r.describe()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(asked).toEqual([]);
  });
});
