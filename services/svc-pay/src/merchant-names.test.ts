import { describe, expect, it } from 'vitest';
import { cleanMerchantName, MERCHANT_NAME_MAX, merchantNameInputSchema, resolveMerchantNames } from './merchant-names.js';

/** Invisible formatting characters a name may not hold. U+200D (zero-width joiner) is deliberately absent. */
const INVISIBLE = [
  '\u061c',
  '\u200e',
  '\u200f',
  '\u202a',
  '\u202b',
  '\u202c',
  '\u202d',
  '\u202e',
  '\u2066',
  '\u2067',
  '\u2068',
  '\u2069',
  '\u2028',
  '\u2029',
  '\u200b',
  '\u2060',
  '\ufeff',
];

describe('cleanMerchantName', () => {
  it('trims and keeps a normal name, including accents and symbols', () => {
    expect(cleanMerchantName('  Acme Shop  ')).toBe('Acme Shop');
    expect(cleanMerchantName('Café Müller & Söhne GmbH')).toBe('Café Müller & Söhne GmbH');
  });
  it('refuses blank, non-string, over-long and control-character values', () => {
    for (const bad of [
      undefined,
      null,
      5,
      '',
      '   ',
      'x'.repeat(MERCHANT_NAME_MAX + 1),
      'a\nb',
      'a\tb',
      'a\u0000b',
      'a\u001bb',
      'a\u007fb',
      'a\u0085b',
    ]) {
      expect(cleanMerchantName(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(cleanMerchantName('x'.repeat(MERCHANT_NAME_MAX))).toBe('x'.repeat(MERCHANT_NAME_MAX));
  });
  it('keeps a zero-width joiner, so emoji sequences are accepted', () => {
    expect(cleanMerchantName('👨\u200d👩\u200d👧 Family Shop')).toBe('👨\u200d👩\u200d👧 Family Shop');
    expect(cleanMerchantName('a\u200db')).toBe('a\u200db');
  });
  it('counts characters, not UTF-16 units, so an emoji is one', () => {
    expect(cleanMerchantName('🍕'.repeat(MERCHANT_NAME_MAX))).not.toBeNull();
    expect(cleanMerchantName('🍕'.repeat(MERCHANT_NAME_MAX + 1))).toBeNull();
  });
});

describe('merchantNameInputSchema', () => {
  it('returns the trimmed name and rejects what the database would', () => {
    expect(merchantNameInputSchema.parse('  Acme  ')).toBe('Acme');
    expect(merchantNameInputSchema.safeParse('   ').success).toBe(false);
    expect(merchantNameInputSchema.safeParse('a\u001b[31m').success).toBe(false);
    expect(merchantNameInputSchema.safeParse(42).success).toBe(false);
  });
});

describe('resolveMerchantNames', () => {
  it('uses explicit names, and falls back to the legal name for the display name', () => {
    expect(resolveMerchantNames({ displayName: 'Acme', legalName: 'Acme Ltd' })).toEqual({ displayName: 'Acme', legalName: 'Acme Ltd' });
    expect(resolveMerchantNames({ legalName: 'Acme Ltd' })).toEqual({ displayName: 'Acme Ltd', legalName: 'Acme Ltd' });
  });
  it('keeps a display name on its own without inventing a legal name', () => {
    expect(resolveMerchantNames({ displayName: 'Acme' })).toEqual({ displayName: 'Acme', legalName: null });
  });
  it('reads the legal name an older client sends inside settlementPrefs.businessDetails', () => {
    expect(resolveMerchantNames({ settlementPrefs: { businessDetails: { legalName: ' Old Client Ltd ' } } })).toEqual({
      displayName: 'Old Client Ltd',
      legalName: 'Old Client Ltd',
    });
  });
  it('ignores a malformed legal name in free-form preferences instead of failing or storing it', () => {
    for (const businessDetails of [{ legalName: 'a\nb' }, { legalName: 7 }, { legalName: 'x'.repeat(500) }, 'text', null, []]) {
      expect(resolveMerchantNames({ settlementPrefs: { businessDetails } })).toEqual({ displayName: null, legalName: null });
    }
  });
  it('prefers an explicit name over the preferences', () => {
    expect(resolveMerchantNames({ legalName: 'Explicit', settlementPrefs: { businessDetails: { legalName: 'Prefs' } } }).legalName).toBe(
      'Explicit',
    );
  });
  it('stores nothing when nothing was given', () => {
    expect(resolveMerchantNames({})).toEqual({ displayName: null, legalName: null });
    expect(resolveMerchantNames({ settlementPrefs: {} })).toEqual({ displayName: null, legalName: null });
  });
});
