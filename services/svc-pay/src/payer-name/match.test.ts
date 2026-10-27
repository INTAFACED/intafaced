import { describe, expect, it } from 'vitest';
import { checkPayerName, checkPayerNames, givenPayerName, normalisePayerName, readPayerNameMatchRule } from './match.js';

describe('the payer-name check on a bank transfer (RC-merchant-09)', () => {
  it('sets aside case, accents, punctuation and spacing, and nothing else', () => {
    expect(normalisePayerName('  Adá   Lovelace-King ')).toBe('ada lovelace king');
    expect(normalisePayerName('ADA LOVELACE KING')).toBe('ada lovelace king');
    expect(normalisePayerName("O'Brien, Seán")).toBe('o brien sean');
    expect(normalisePayerName('...')).toBe('');
  });

  it('holds "A LOVELACE" against "Ada Lovelace" under exact_normalised, and lets the same name through', () => {
    expect(checkPayerName('exact_normalised', 'Ada Lovelace', 'A LOVELACE')).toEqual({
      outcome: 'hold',
      reason: 'pay.payer_name_mismatch',
    });
    expect(checkPayerName('exact_normalised', 'Ada Lovelace', 'ADA  LOVELACE')).toEqual({ outcome: 'match' });
    expect(checkPayerName('exact_normalised', 'Ada Lovelace', 'Lovelace Ada')).toEqual({
      outcome: 'hold',
      reason: 'pay.payer_name_mismatch',
    });
  });

  it('holds when the rule is unset, whatever the names, and never guesses one', () => {
    expect(checkPayerName(null, 'Ada Lovelace', 'Ada Lovelace')).toEqual({ outcome: 'hold', reason: 'pay.name_match_rule_unset' });
  });

  it('holds when either name is missing: the bank reported none, or none was given', () => {
    expect(checkPayerName('exact_normalised', 'Ada Lovelace', undefined)).toEqual({ outcome: 'hold', reason: 'pay.payer_name_missing' });
    expect(checkPayerName('exact_normalised', 'Ada Lovelace', ' - ')).toEqual({ outcome: 'hold', reason: 'pay.payer_name_missing' });
    expect(checkPayerName('exact_normalised', null, 'Ada Lovelace')).toEqual({ outcome: 'hold', reason: 'pay.payer_name_missing' });
  });

  it('takes a given name that a bank could hold, and nothing else', () => {
    expect(givenPayerName('  Ada   Lovelace ')).toBe('Ada Lovelace');
    expect(givenPayerName('')).toBeNull();
    expect(givenPayerName('  ')).toBeNull();
    expect(givenPayerName('!!!')).toBeNull();
    expect(givenPayerName('x'.repeat(141))).toBeNull();
    expect(givenPayerName(42)).toBeNull();
    expect(givenPayerName(undefined)).toBeNull();
    // A control character is never part of a name, and Postgres text cannot hold NUL.
    expect(givenPayerName('Ada\u0000Lovelace')).toBeNull();
    expect(givenPayerName('Ada\u0007 Lovelace')).toBeNull();
  });

  it('reads the owner rule at boot: blank is none, an unknown one refuses', () => {
    expect(readPayerNameMatchRule({})).toBeNull();
    expect(readPayerNameMatchRule({ PAY_PAYER_NAME_MATCH_RULE: '  ' })).toBeNull();
    expect(readPayerNameMatchRule({ PAY_PAYER_NAME_MATCH_RULE: 'exact_normalised' })).toBe('exact_normalised');
    expect(() => readPayerNameMatchRule({ PAY_PAYER_NAME_MATCH_RULE: 'fuzzy' })).toThrow(/not a rule this build has/);
  });

  it('checks every transfer counted: one from another name holds them all, a mismatch named before a missing name', () => {
    expect(checkPayerNames('exact_normalised', 'Ada Lovelace', [])).toEqual({ outcome: 'match' });
    expect(checkPayerNames('exact_normalised', 'Ada Lovelace', ['ADA LOVELACE', 'ada lovelace'])).toEqual({ outcome: 'match' });
    expect(checkPayerNames('exact_normalised', 'Ada Lovelace', ['Ada Lovelace', 'Mallory'])).toEqual({
      outcome: 'hold',
      reason: 'pay.payer_name_mismatch',
    });
    expect(checkPayerNames('exact_normalised', 'Ada Lovelace', [null, 'Mallory'])).toEqual({
      outcome: 'hold',
      reason: 'pay.payer_name_mismatch',
    });
    expect(checkPayerNames('exact_normalised', 'Ada Lovelace', ['Ada Lovelace', null])).toEqual({
      outcome: 'hold',
      reason: 'pay.payer_name_missing',
    });
    expect(checkPayerNames(null, 'Ada Lovelace', ['Ada Lovelace'])).toEqual({ outcome: 'hold', reason: 'pay.name_match_rule_unset' });
  });
});
