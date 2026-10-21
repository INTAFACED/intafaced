import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount as amt } from '@intafaced/ledger-client';
import { clampToCap, premiumOf, trimmedMeanPremium } from './funding-rate-computer.js';
import { missingFundingParams, validateFundingParams, BLANK_FUNDING_PARAMS } from './funding-params.js';
import { preferFundingRateSource } from './funding-rate-source.js';

describe('premium', () => {
  it('is (mark - index) / index', () => {
    expect(formatAmount(premiumOf({ mark: amt('101'), index: amt('100') }))).toBe('0.01');
    expect(formatAmount(premiumOf({ mark: amt('99'), index: amt('100') }))).toBe('-0.01');
    expect(formatAmount(premiumOf({ mark: amt('100'), index: amt('100') }))).toBe('0');
  });

  it('rounds half-up at 18 decimals, in bigint', () => {
    // 1/3 -> 0.333333333333333333
    expect(formatAmount(premiumOf({ mark: amt('4'), index: amt('3') }))).toBe('0.333333333333333333');
  });
});

describe('trimmed mean', () => {
  const p = (xs: string[]) => xs.map((x) => amt(x));

  it('drops floor(n * ratio) from each tail', () => {
    const r = trimmedMeanPremium(p(['0.01', '0.01', '0.01', '0.01', '0.01', '0.01', '0.01', '0.01', '0.01', '1']), 1000);
    expect(r!.trimmedPerTail).toBe(1);
    expect(r!.dropped.map(formatAmount).sort()).toEqual(['0.01', '1']);
    expect(formatAmount(r!.premium)).toBe('0.01');
  });

  it('a ratio that rounds to zero trims nothing', () => {
    const r = trimmedMeanPremium(p(['0.01', '0.03']), 100);
    expect(r!.trimmedPerTail).toBe(0);
    expect(formatAmount(r!.premium)).toBe('0.02');
  });

  it('an explicit zero ratio is a stated choice, not blank', () => {
    expect(trimmedMeanPremium(p(['1', '2', '3']), 0)!.kept).toBe(3);
  });

  it('is null for no samples', () => {
    expect(trimmedMeanPremium([], 100)).toBeNull();
  });
});

describe('clamp', () => {
  it('flags only when it bites, on both sides', () => {
    expect(clampToCap(amt('0.005'), amt('0.01'))).toEqual({ rate: amt('0.005'), clamped: false });
    expect(clampToCap(amt('0.02'), amt('0.01'))).toEqual({ rate: amt('0.01'), clamped: true });
    expect(clampToCap(amt('-0.02'), amt('0.01'))).toEqual({ rate: amt('-0.01'), clamped: true });
    expect(clampToCap(amt('0.01'), amt('0.01')).clamped).toBe(false);
  });
});

describe('funding params', () => {
  it('names every blank number the formula needs', () => {
    expect(missingFundingParams(BLANK_FUNDING_PARAMS)).toEqual(['baseComponent', 'cap', 'cadenceSeconds', 'trimRatioBps', 'minSamples']);
  });

  it('validates and keeps blank blank', () => {
    expect(validateFundingParams(BLANK_FUNDING_PARAMS)).toEqual(BLANK_FUNDING_PARAMS);
    expect(() => validateFundingParams({ ...BLANK_FUNDING_PARAMS, cap: '0' })).toThrow(/cap/);
    expect(() => validateFundingParams({ ...BLANK_FUNDING_PARAMS, cap: '-1' })).toThrow(/cap/);
    expect(() => validateFundingParams({ ...BLANK_FUNDING_PARAMS, baseComponent: '1e-4' })).toThrow(/baseComponent/);
    expect(() => validateFundingParams({ ...BLANK_FUNDING_PARAMS, trimRatioBps: 5000 })).toThrow(/trimRatioBps/);
    expect(() => validateFundingParams({ ...BLANK_FUNDING_PARAMS, minSamples: 0 })).toThrow(/minSamples/);
    expect(validateFundingParams({ ...BLANK_FUNDING_PARAMS, baseComponent: '-0.0001', trimRatioBps: 0 })).toMatchObject({
      baseComponent: '-0.0001',
      trimRatioBps: 0,
    });
  });
});

describe('rate source preference', () => {
  it('asks the fallback only when the primary has no rate', async () => {
    const none = {
      async quote() {
        return null;
      },
    };
    const a = {
      async quote({ marketId }: { marketId: string }) {
        return { rate: '0.1', periodId: 'p-a', marketId };
      },
    };
    const b = {
      async quote({ marketId }: { marketId: string }) {
        return { rate: '0.2', periodId: 'p-b', marketId };
      },
    };
    const at = new Date();
    expect((await preferFundingRateSource(a, b).quote({ marketId: 'm', at }))!.periodId).toBe('p-a');
    expect((await preferFundingRateSource(none, b).quote({ marketId: 'm', at }))!.periodId).toBe('p-b');
    expect(await preferFundingRateSource(none, none).quote({ marketId: 'm', at })).toBeNull();
  });
});
