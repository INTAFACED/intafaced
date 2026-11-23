import { describe, expect, it } from 'vitest';
import {
  MARKETING_BAN_WORDS,
  OWNER_SEAL_MARKER,
  assertMarketingLanguageAllowed,
  findUnsealedMarketingClaims,
  hasOwnerSeal,
  isHonestMarketingLanguageUse,
} from './marketing-language.js';

/** The copy lint rule's own word list and judge (garden/no-unsealed-claim), a plain .js module with no type file. */
type CopyRules = { CLAIM_WORDS: readonly string[]; unsealedClaims: (line: string, previousLine?: string) => string[] };
const copyRulesUrl = new URL('../../../tooling/lint/oxlint-plugin-garden/copy-rules.js', import.meta.url).href;
const { CLAIM_WORDS, unsealedClaims } = (await import(copyRulesUrl)) as CopyRules;

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
  });

  it('allows honesty-field i18n keys without treating the label as a claim', () => {
    expect(isHonestMarketingLanguageUse('            audited: "Template audited",')).toBe(true);
    expect(findUnsealedMarketingClaims('            audited: "Template audited",')).toEqual([]);
  });

  it('stays in lockstep with the copy lint rule that applies it (seal + words)', () => {
    // The rule's own list and judge (garden/no-unsealed-claim), called, not read.
    expect([...CLAIM_WORDS]).toEqual([...MARKETING_BAN_WORDS]);
    for (const word of MARKETING_BAN_WORDS) {
      const claim = `Every vault is ${word}.`;
      expect(unsealedClaims(claim), `the rule refuses an unsealed "${word}"`).toEqual([word]);
      expect(findUnsealedMarketingClaims(claim).map((h) => h.word)).toEqual([word]);
      // The seal this module spells, on the line or the one above, clears it in the rule too.
      expect(unsealedClaims(`${claim} ${OWNER_SEAL_MARKER}`), `the rule accepts the seal ${OWNER_SEAL_MARKER}`).toEqual([]);
      expect(unsealedClaims(claim, OWNER_SEAL_MARKER)).toEqual([]);
    }
  });
});
