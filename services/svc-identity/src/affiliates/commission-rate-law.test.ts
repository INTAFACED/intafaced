import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AccrualRateRefuseError,
  AFFILIATE_ACCRUAL_RATE_RESIDUAL,
  accrualTierLawIsPublished,
  accrualTierLawStatusLine,
  parseAccrualTierLawJson,
  resolveAccrualTiers,
  UNPUBLISHED_ACCRUAL_TIER_LAW,
} from './commission-rate-law.js';
import { CommissionError } from './commission.js';

describe('affiliate accrual rate law — refuse-closed (no invent)', () => {
  it('blank env → unpublished', () => {
    expect(parseAccrualTierLawJson(undefined)).toEqual(UNPUBLISHED_ACCRUAL_TIER_LAW);
    expect(parseAccrualTierLawJson('')).toEqual(UNPUBLISHED_ACCRUAL_TIER_LAW);
    expect(parseAccrualTierLawJson('   ')).toEqual(UNPUBLISHED_ACCRUAL_TIER_LAW);
    expect(accrualTierLawIsPublished(UNPUBLISHED_ACCRUAL_TIER_LAW)).toBe(false);
    expect(accrualTierLawStatusLine(UNPUBLISHED_ACCRUAL_TIER_LAW)).toBe('published=0 tiers=0');
  });

  it('published:false JSON → unpublished', () => {
    expect(parseAccrualTierLawJson('{"published":false}')).toEqual(UNPUBLISHED_ACCRUAL_TIER_LAW);
  });

  it('published tiers parse and resolve from law', () => {
    const law = parseAccrualTierLawJson(
      JSON.stringify({
        published: true,
        tiers: [
          { hop: 0, rate: '0.10' },
          { hop: 1, rate: '0.05' },
        ],
      }),
    );
    expect(law.published).toBe(true);
    if (!law.published) throw new Error('expected published');
    expect(law.tiers).toHaveLength(2);
    expect(resolveAccrualTiers({ law })).toEqual(law.tiers);
    expect(accrualTierLawStatusLine(law)).toBe('published=1 tiers=2');
  });

  it('request tiers win over unpublished law', () => {
    const request = [{ hop: 0, rate: '0.08' }] as const;
    expect(resolveAccrualTiers({ requestTiers: request, law: UNPUBLISHED_ACCRUAL_TIER_LAW })).toEqual(request);
  });

  it('no request + unpublished law → AccrualRateRefuseError with residual', () => {
    expect(() => resolveAccrualTiers({ law: UNPUBLISHED_ACCRUAL_TIER_LAW })).toThrow(AccrualRateRefuseError);
    try {
      resolveAccrualTiers({ law: UNPUBLISHED_ACCRUAL_TIER_LAW });
    } catch (err) {
      expect(err).toBeInstanceOf(AccrualRateRefuseError);
      const e = err as AccrualRateRefuseError;
      expect(e.code).toBe('affiliate.accrual.rates_unset');
      expect(e.residual).toBe(AFFILIATE_ACCRUAL_RATE_RESIDUAL);
    }
  });

  it('empty request array does not invent — falls through to refuse', () => {
    expect(() => resolveAccrualTiers({ requestTiers: [], law: UNPUBLISHED_ACCRUAL_TIER_LAW })).toThrow(AccrualRateRefuseError);
  });

  it('malformed env JSON fails boot (throws), does not invent', () => {
    expect(() => parseAccrualTierLawJson('{not-json')).toThrow(CommissionError);
    expect(() => parseAccrualTierLawJson('{"published":true}')).toThrow(CommissionError);
    expect(() => parseAccrualTierLawJson('{"published":true,"tiers":[]}')).toThrow(CommissionError);
    expect(() => parseAccrualTierLawJson(JSON.stringify({ published: true, tiers: [{ hop: 0, rate: '2' }] }))).toThrow(CommissionError);
  });

  it('.env.example leaves the owner rates blank (public repo; set on the host), and blank refuses', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
    const example = readFileSync(join(root, '.env.example'), 'utf8');
    const line = example.split(/\r?\n/).find((l) => l.startsWith('IDENTITY_AFFILIATE_ACCRUAL_TIERS_JSON='));
    expect(line).toBe('IDENTITY_AFFILIATE_ACCRUAL_TIERS_JSON=');
    const law = parseAccrualTierLawJson(line!.slice('IDENTITY_AFFILIATE_ACCRUAL_TIERS_JSON='.length));
    expect(law.published).toBe(false);
    expect(() => resolveAccrualTiers({ law })).toThrow(AccrualRateRefuseError);
  });
});
