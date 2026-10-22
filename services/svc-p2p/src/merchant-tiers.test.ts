import { parseAmount } from '@intafaced/ledger-client';
import { describe, expect, it } from 'vitest';
import {
  TIER_EDGES,
  TierError,
  assertTierTransition,
  parseTierPolicy,
  qualifyingRank,
  reassess,
  requestDowngrade,
  tierBadge,
  tierBenefits,
  type MerchantTierRecord,
  type TierState,
} from './merchant-tiers.js';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof TierError ? e.code : 'other';
  }
  return undefined;
};

const ladderIn = [
  { rank: 2, name: 'Gold', minCompletedTrades: 100, minCompletionBps: 9500, orderCeiling: '50000', maxPendingOrders: 10 },
  { rank: 1, name: 'Silver', minCompletedTrades: 20, minCompletionBps: 9000, orderCeiling: '10000', maxPendingOrders: 5 },
];
const policy = parseTierPolicy({ ladder: ladderIn, upgradeDelayMs: 1000, assessmentPeriodMs: 5000 });
const rec = (o: Partial<MerchantTierRecord> = {}): MerchantTierRecord => ({
  rank: null,
  state: 'active',
  qualifiedSince: null,
  assessmentEndsAt: null,
  ...o,
});

describe('P-ads-merchant-13 ladder', () => {
  it('blank owner values refuse with p2p.tier_ladder_unset', () => {
    expect(code(() => parseTierPolicy({}))).toBe('p2p.tier_ladder_unset');
    expect(code(() => parseTierPolicy({ ladder: [], upgradeDelayMs: 1, assessmentPeriodMs: 1 }))).toBe('p2p.tier_ladder_unset');
    expect(code(() => parseTierPolicy({ ladder: ladderIn, upgradeDelayMs: null, assessmentPeriodMs: 1 }))).toBe('p2p.tier_ladder_unset');
  });
  it('sorts by rank and rejects a non-monotone or duplicate ladder', () => {
    expect(policy.ladder.map((t) => t.name)).toEqual(['Silver', 'Gold']);
    expect(policy.ladder[1]!.benefits.orderCeiling).toBe(parseAmount('50000'));
    const easier = [ladderIn[1]!, { ...ladderIn[0]!, minCompletedTrades: 5 }];
    expect(code(() => parseTierPolicy({ ladder: easier, upgradeDelayMs: 0, assessmentPeriodMs: 0 }))).toBe('p2p.invalid_tier');
    const dup = [ladderIn[1]!, { ...ladderIn[0]!, rank: 1 }];
    expect(code(() => parseTierPolicy({ ladder: dup, upgradeDelayMs: 0, assessmentPeriodMs: 0 }))).toBe('p2p.invalid_tier');
    const bad = [{ ...ladderIn[1]!, orderCeiling: '0' }];
    expect(code(() => parseTierPolicy({ ladder: bad, upgradeDelayMs: 0, assessmentPeriodMs: 0 }))).toBe('p2p.invalid_tier');
  });
  it('qualifyingRank picks the highest met tier; no history qualifies for nothing', () => {
    expect(qualifyingRank(policy.ladder, { completedTrades: 150, completionBps: 9600 })).toBe(2);
    expect(qualifyingRank(policy.ladder, { completedTrades: 150, completionBps: 9400 })).toBe(1);
    expect(qualifyingRank(policy.ladder, { completedTrades: 5, completionBps: 10000 })).toBeNull();
    expect(qualifyingRank(policy.ladder, { completedTrades: 0, completionBps: null })).toBeNull();
  });
});

describe('P-ads-merchant-13 automatic review', () => {
  const gold = { completedTrades: 150, completionBps: 9600 };
  it('blank policy or non-approved merchant: sweeper does nothing', () => {
    expect(reassess({ policy: null, status: 'approved', record: rec(), metrics: gold, now: 0 })).toEqual({ kind: 'none' });
    for (const s of ['suspended', 'applied', 'rejected', 'withdrawn'] as const) {
      expect(reassess({ policy, status: s, record: rec(), metrics: gold, now: 0 })).toEqual({ kind: 'none' });
    }
  });
  it('never upgrades before the delay; upgrades once; re-run is a no-op', () => {
    expect(reassess({ policy, status: 'approved', record: rec(), metrics: gold, now: 10 })).toEqual({
      kind: 'start_upgrade_clock',
      at: 10,
    });
    const clock = rec({ qualifiedSince: 10 });
    expect(reassess({ policy, status: 'approved', record: clock, metrics: gold, now: 1009 })).toEqual({ kind: 'none' });
    expect(reassess({ policy, status: 'approved', record: clock, metrics: gold, now: 1010 })).toEqual({
      kind: 'upgrade',
      from: null,
      to: 2,
    });
    const after = rec({ rank: 2, qualifiedSince: null });
    expect(reassess({ policy, status: 'approved', record: after, metrics: gold, now: 2000 })).toEqual({ kind: 'none' });
  });
  it('falling below starts assessment, downgrades at its end, recovers early', () => {
    const r = rec({ rank: 2 });
    const silver = { completedTrades: 150, completionBps: 9100 };
    expect(reassess({ policy, status: 'approved', record: r, metrics: silver, now: 100 })).toEqual({
      kind: 'start_assessment',
      endsAt: 5100,
    });
    const a = rec({ rank: 2, state: 'assessment', assessmentEndsAt: 5100 });
    expect(reassess({ policy, status: 'approved', record: a, metrics: silver, now: 5099 })).toEqual({ kind: 'none' });
    expect(reassess({ policy, status: 'approved', record: a, metrics: silver, now: 5100 })).toEqual({
      kind: 'downgrade',
      from: 2,
      to: 1,
    });
    expect(reassess({ policy, status: 'approved', record: a, metrics: gold, now: 200 })).toEqual({ kind: 'end_assessment' });
  });
  it('tier states move only along the closed edge list', () => {
    const states = Object.keys(TIER_EDGES) as TierState[];
    for (const f of states)
      for (const t of states) {
        const allowed = TIER_EDGES[f].includes(t);
        expect(code(() => assertTierTransition(f, t))).toBe(allowed ? undefined : 'p2p.invalid_tier_transition');
      }
  });
  it('requestDowngrade needs a reason and a legal edge', () => {
    expect(code(() => requestDowngrade(rec({ rank: 1 }), '  '))).toBe('p2p.reason_required');
    expect(requestDowngrade(rec({ rank: 1 }), 'too busy')).toBe('downgrade_requested');
    expect(code(() => requestDowngrade(rec({ rank: 1, state: 'revoked' }), 'x'))).toBe('p2p.invalid_tier_transition');
  });
});

describe('P-ads-merchant-13 benefits and badge', () => {
  const r = rec({ rank: 2 });
  it('approved merchant with a tier gets benefits and a name-only badge', () => {
    expect(tierBenefits(policy, 'approved', r)).toEqual({ orderCeiling: parseAmount('50000'), maxPendingOrders: 10 });
    expect(tierBadge(policy, 'approved', r)).toEqual({ rank: 2, name: 'Gold' });
  });
  it('standing wins: a suspended merchant with a tier gets no benefits or badge', () => {
    expect(tierBenefits(policy, 'suspended', r)).toBeNull();
    expect(tierBadge(policy, 'suspended', r)).toBeNull();
  });
  it('blank ladder, revoked tier or no tier: nothing', () => {
    expect(tierBenefits(null, 'approved', r)).toBeNull();
    expect(tierBadge(null, 'approved', r)).toBeNull();
    expect(tierBenefits(policy, 'approved', rec({ rank: 2, state: 'revoked' }))).toBeNull();
    expect(tierBenefits(policy, 'approved', rec())).toBeNull();
  });
});
