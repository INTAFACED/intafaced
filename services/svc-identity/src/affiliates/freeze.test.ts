import { describe, expect, it } from 'vitest';
import { MemoryReferralTree } from './referral-tree.js';
import {
  accrueWithFreezes,
  freezeFilterBoardCard,
  freezeFilterStatusLine,
  parseFreezeFilterStatusLine,
  freezeFilterStatusLineMatches,
  freezeFilterStatusLineConsistent,
  freezeFilterExportHeader,
  freezeFilterExportLine,
  freezeFilterExportText,
  freezeSkippedAtLeast,
} from './freeze.js';

/** Test fixture only — not a production default (DIRECTION §8). */
const FIXTURE_TIERS = [
  { hop: 0, rate: '0.130' },
  { hop: 1, rate: '0.07' },
  { hop: 2, rate: '0.03' },
] as const;

describe('affiliates freeze at accrual (no payout)', () => {
  it('skips frozen beneficiary rows', () => {
    const tree = new MemoryReferralTree();
    tree.attribute({ userId: 'u2', referrerId: 'u1' });
    tree.attribute({ userId: 'u3', referrerId: 'u2' });
    const parent = new Map(tree.listEdges().map((e) => [e.userId, e.referrerId]));
    const all = accrueWithFreezes({
      fee: {
        feeEventId: 'f1',
        userId: 'u3',
        feeAmount: '100',
        asset: 'USDT',
        at: new Date('2026-08-05T00:00:00.000Z'),
      },
      parent,
      tiers: FIXTURE_TIERS,
      frozenBeneficiaryIds: new Set(),
    });
    expect(all.length).toBeGreaterThan(0);
    const frozen = accrueWithFreezes({
      fee: {
        feeEventId: 'f1',
        userId: 'u3',
        feeAmount: '100',
        asset: 'USDT',
        at: new Date('2026-08-05T00:00:00.000Z'),
      },
      parent,
      tiers: FIXTURE_TIERS,
      frozenBeneficiaryIds: new Set(['u2']),
    });
    expect(frozen.every((r) => r.beneficiaryId !== 'u2')).toBe(true);
    expect(frozen.length).toBeLessThan(all.length);
  });
});

describe('L3 wave53 freeze filter status/export', () => {
  it('compares with/without freeze without invent', () => {
    const tree = new MemoryReferralTree();
    tree.attribute({ userId: 'u2', referrerId: 'u1' });
    tree.attribute({ userId: 'u3', referrerId: 'u2' });
    const parent = new Map(tree.listEdges().map((e) => [e.userId, e.referrerId]));
    const input = {
      fee: {
        feeEventId: 'f1',
        userId: 'u3',
        feeAmount: '100',
        asset: 'USDT',
        at: new Date('2026-08-05T00:00:00.000Z'),
      },
      parent,
      tiers: FIXTURE_TIERS,
      frozenBeneficiaryIds: new Set(['u2']),
    };
    const card = freezeFilterBoardCard(input);
    expect(card.skipped).toBeGreaterThan(0);
    expect(card.withFreeze).toBeLessThan(card.withoutFreeze);
    expect(freezeFilterStatusLineMatches(input)).toBe(true);
    expect(freezeFilterStatusLineConsistent(freezeFilterStatusLine(input))).toBe(true);
    expect(parseFreezeFilterStatusLine('nope')).toBeNull();
    expect(freezeFilterExportText(input).startsWith(freezeFilterExportHeader())).toBe(true);
    expect(freezeFilterExportLine(input)).toContain(',');
    expect(freezeSkippedAtLeast(input, 1)).toBe(true);
    expect(freezeSkippedAtLeast(input, Number.NaN)).toBe(false);
  });
});
