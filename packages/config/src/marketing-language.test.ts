import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MARKETING_BAN_WORDS,
  OWNER_SEAL_MARKER,
  assertMarketingLanguageAllowed,
  findUnsealedMarketingClaims,
  hasOwnerSeal,
  isHonestMarketingLanguageUse,
} from './marketing-language.js';

describe('marketing language ban (D26-P0-16 / §8.9)', () => {
  it('freezes the three ban words and the owner seal spelling', () => {
    expect([...MARKETING_BAN_WORDS]).toEqual(['audited', 'insured', 'guaranteed']);
    expect(OWNER_SEAL_MARKER).toBe('OWNER-SEAL(§8.9)');
    expect(hasOwnerSeal(OWNER_SEAL_MARKER)).toBe(true);
    expect(hasOwnerSeal('OWNER-SEAL( 8.9 )')).toBe(true);
  });

  it('refuses affirmative claims without a seal', () => {
    expect(findUnsealedMarketingClaims('Our contracts are fully audited.').map((h) => h.word)).toEqual(['audited']);
    expect(findUnsealedMarketingClaims('Deposits are insured by the house.').map((h) => h.word)).toEqual(['insured']);
    expect(findUnsealedMarketingClaims('Guaranteed yield every month.').map((h) => h.word)).toEqual(['guaranteed']);
    expect(findUnsealedMarketingClaims('audited: true').map((h) => h.word)).toEqual(['audited']);
    const refused = assertMarketingLanguageAllowed('audited: true');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe('refuse.marketing_language_unsealed');
  });

  it('allows the same claims when the line or previous line carries the seal', () => {
    expect(findUnsealedMarketingClaims(`Fully audited. ${OWNER_SEAL_MARKER}`)).toEqual([]);
    expect(findUnsealedMarketingClaims('Fully audited by counsel.', OWNER_SEAL_MARKER)).toEqual([]);
    expect(assertMarketingLanguageAllowed('Insured float.', OWNER_SEAL_MARKER)).toEqual({ ok: true });
  });

  it('allows honest negations and status-false without a seal', () => {
    expect(isHonestMarketingLanguageUse('Template is not audited until a real audit.')).toBe(true);
    expect(isHonestMarketingLanguageUse('marked audited:false until a real audit exists')).toBe(true);
    expect(isHonestMarketingLanguageUse('not a guaranteed yield')).toBe(true);
    expect(isHonestMarketingLanguageUse('unaudited venue')).toBe(true);
    expect(findUnsealedMarketingClaims('Template is not audited until a real audit.')).toEqual([]);
    expect(findUnsealedMarketingClaims('profit share is not a guaranteed yield')).toEqual([]);
    expect(findUnsealedMarketingClaims('marked audited:false until a real audit exists')).toEqual([]);
    expect(findUnsealedMarketingClaims('unaudited venue')).toEqual([]);
  });

  it('does not let an honest ban word clear the rest of the line', () => {
    expect(
      findUnsealedMarketingClaims('not audited; deposits are insured and guaranteed').map((h) => h.word),
    ).toEqual(['insured', 'guaranteed']);
    expect(findUnsealedMarketingClaims('not audited; contracts are fully audited.').map((h) => h.word)).toEqual([
      'audited',
    ]);
    expect(
      findUnsealedMarketingClaims('not audited; deposits are insured and guaranteed', OWNER_SEAL_MARKER),
    ).toEqual([]);
    expect(
      findUnsealedMarketingClaims(`not audited; deposits are insured. ${OWNER_SEAL_MARKER}`),
    ).toEqual([]);
  });

  it('allows honesty-field i18n keys without treating the label as a claim', () => {
    expect(isHonestMarketingLanguageUse('            audited: "Template audited",')).toBe(true);
    expect(findUnsealedMarketingClaims('            audited: "Template audited",')).toEqual([]);
  });

  it('stays in lockstep with the CI gate source (seal + words)', () => {
    const gatePath = join(process.cwd(), '../../tooling/ci/marketing-language-scan.mjs');
    const gate = readFileSync(gatePath, 'utf8');
    expect(gate).toContain(OWNER_SEAL_MARKER);
    for (const word of MARKETING_BAN_WORDS) {
      expect(gate).toContain(`'${word}'`);
    }
    expect(gate).toContain('packages/config/src/marketing-language.ts');
  });
});
