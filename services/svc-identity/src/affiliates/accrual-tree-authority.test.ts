import { describe, expect, it } from 'vitest';
import { accrueTreeUnderRateAuthority, accrualTreeAuthorityStatusLine } from './accrual-tree-authority.js';
import { AccrualRateRefuseError, UNPUBLISHED_ACCRUAL_TIER_LAW } from './commission-rate-law.js';
import type { FeeEvent } from './commission.js';

const PAYER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BENE0 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BENE1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function tree(): Map<string, string> {
  // payer ← bene0 ← bene1 (ancestors: [bene0, bene1])
  return new Map([
    [PAYER, BENE0],
    [BENE0, BENE1],
  ]);
}

function fee(over: Partial<FeeEvent> = {}): FeeEvent {
  return {
    feeEventId: 'fee-o2-1',
    userId: PAYER,
    feeAmount: '100',
    asset: 'USDT',
    at: new Date('2026-08-12T00:00:00.000Z'),
    sourceModule: 'trade',
    ...over,
  };
}

const PUBLISHED = {
  published: true as const,
  tiers: [
    { hop: 0, rate: '0.130' },
    { hop: 1, rate: '0.07' },
  ],
};

describe('accrueTreeUnderRateAuthority (D26-P1-O2)', () => {
  it('unpublished law + durable → affiliate.accrual.rates_unset (no invent)', () => {
    expect(() =>
      accrueTreeUnderRateAuthority({
        fee: fee(),
        parent: tree(),
        law: UNPUBLISHED_ACCRUAL_TIER_LAW,
        mode: 'durable',
      }),
    ).toThrow(AccrualRateRefuseError);
    try {
      accrueTreeUnderRateAuthority({
        fee: fee(),
        parent: tree(),
        law: UNPUBLISHED_ACCRUAL_TIER_LAW,
        mode: 'durable',
      });
    } catch (err) {
      expect(err).toBeInstanceOf(AccrualRateRefuseError);
      expect((err as AccrualRateRefuseError).code).toBe('affiliate.accrual.rates_unset');
    }
  });

  it('durable + per-call tiers → invent_refused even when law published', () => {
    expect(() =>
      accrueTreeUnderRateAuthority({
        fee: fee(),
        parent: tree(),
        law: PUBLISHED,
        mode: 'durable',
        simulationTiers: [{ hop: 0, rate: '0.99' }],
      }),
    ).toThrow(AccrualRateRefuseError);
    try {
      accrueTreeUnderRateAuthority({
        fee: fee(),
        parent: tree(),
        law: PUBLISHED,
        mode: 'durable',
        simulationTiers: [{ hop: 0, rate: '0.99' }],
      });
    } catch (err) {
      expect((err as AccrualRateRefuseError).code).toBe('affiliate.accrual.invent_refused');
    }
  });

  it('published law accrues along the tree (decimal strings, no invent)', () => {
    const out = accrueTreeUnderRateAuthority({
      fee: fee(),
      parent: tree(),
      law: PUBLISHED,
      mode: 'durable',
    });
    expect(out.rows).toHaveLength(2);
    expect(out.rows[0]).toMatchObject({
      beneficiaryId: BENE0,
      hop: 0,
      rate: '0.130',
      commissionAmount: '13',
      sourceModule: 'trade',
    });
    expect(out.rows[1]).toMatchObject({
      beneficiaryId: BENE1,
      hop: 1,
      rate: '0.07',
      commissionAmount: '7',
    });
    expect(out.frozenSkipped).toBe(0);
    expect(out.mode).toBe('durable');
  });

  it('frozen beneficiary is skipped — not inventing a substitute', () => {
    const out = accrueTreeUnderRateAuthority({
      fee: fee(),
      parent: tree(),
      law: PUBLISHED,
      frozenBeneficiaryIds: new Set([BENE0]),
      mode: 'durable',
    });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]!.beneficiaryId).toBe(BENE1);
    expect(out.frozenSkipped).toBe(1);
  });

  it('zero fee → zero rows (honest empty, not invent)', () => {
    const out = accrueTreeUnderRateAuthority({
      fee: fee({ feeAmount: '0' }),
      parent: tree(),
      law: PUBLISHED,
      mode: 'durable',
    });
    expect(out.rows).toEqual([]);
    expect(out.frozenSkipped).toBe(0);
  });

  it('dry-run may use simulation tiers when law unpublished', () => {
    const out = accrueTreeUnderRateAuthority({
      fee: fee(),
      parent: tree(),
      law: UNPUBLISHED_ACCRUAL_TIER_LAW,
      mode: 'dryRun',
      simulationTiers: [{ hop: 0, rate: '0.08' }],
    });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]!.rate).toBe('0.08');
    expect(out.rows[0]!.commissionAmount).toBe('8');
    expect(out.mode).toBe('dryRun');
  });

  it('dry-run without simulation + unpublished → rates_unset', () => {
    expect(() =>
      accrueTreeUnderRateAuthority({
        fee: fee(),
        parent: tree(),
        law: UNPUBLISHED_ACCRUAL_TIER_LAW,
        mode: 'dryRun',
      }),
    ).toThrow(AccrualRateRefuseError);
  });

  it('status line never invents rates', () => {
    expect(accrualTreeAuthorityStatusLine(UNPUBLISHED_ACCRUAL_TIER_LAW)).toBe('authority=0 published=0 tiers=0');
    expect(accrualTreeAuthorityStatusLine(PUBLISHED)).toBe('authority=1 published=1 tiers=2');
  });
});
