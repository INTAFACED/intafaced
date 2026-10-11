import { describe, expect, it } from 'vitest';
import { compileSafe, isSafeMethodId, safeTest, DEFAULT_MAX_INPUT_LEN } from './index.js';

describe('FH-SEC-01 safe-regex (RE2)', () => {
  it('matches simple anchored patterns', () => {
    const r = safeTest('^hello$', 'hello');
    expect(r).toEqual({ ok: true, matched: true, groups: [] });
  });

  it('returns capture groups in order, without group 0', () => {
    const r = safeTest('^(he)(llo)$', 'hello');
    expect(r).toEqual({ ok: true, matched: true, groups: ['he', 'llo'] });
  });

  it('keeps an unmatched optional group as null', () => {
    const r = safeTest('^(x)(y)?$', 'x');
    expect(r).toEqual({ ok: true, matched: true, groups: ['x', null] });
  });

  it('returns no groups when the pattern does not match', () => {
    const r = safeTest('^(a)(b)$', 'z');
    expect(r).toEqual({ ok: true, matched: false, groups: [] });
  });

  it('refuses oversize input without matching (length cap)', () => {
    const huge = 'a'.repeat(DEFAULT_MAX_INPUT_LEN + 1);
    const r = safeTest('^a+$', huge, { maxInputLen: DEFAULT_MAX_INPUT_LEN });
    expect(r).toEqual({ ok: false, reason: 'input_too_long' });
  });

  it('isSafeMethodId accepts sepa / bank_transfer style ids', () => {
    expect(isSafeMethodId('sepa')).toBe(true);
    expect(isSafeMethodId('bank_transfer')).toBe(true);
    expect(isSafeMethodId('wire-usd')).toBe(true);
  });

  it('isSafeMethodId refuses empty, uppercase dump, spaces, and oversize', () => {
    expect(isSafeMethodId('')).toBe(false);
    expect(isSafeMethodId('SEPA')).toBe(false);
    expect(isSafeMethodId('sepa transfer')).toBe(false);
    expect(isSafeMethodId('a'.repeat(65))).toBe(false);
  });

  /**
   * Classic catastrophic backtracking pattern on JS RegExp:
   *   /^(a+)+$/ against 'a'.repeat(N) + '!'
   * RE2-class matchers stay linear. We assert the call returns promptly
   * and does not hang the test process (vitest default timeout).
   */
  it('evil nested quantifier pattern does not hang on adversarial input', () => {
    const evil = 'a'.repeat(40) + '!';
    const started = Date.now();
    // re2js may reject the pattern or match linearly — either is safe vs hang.
    const r = safeTest('^(a+)+$', evil);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(500);
    // Result is either refuse pattern, or ok with matched=false (linear fail).
    if (r.ok) {
      expect(r.matched).toBe(false);
    } else {
      expect(['pattern_invalid', 'input_too_long']).toContain(r.reason);
    }
  });

  it('compileSafe reuses for repeated tests', () => {
    const re = compileSafe('^id-[0-9]+$');
    expect(safeTest(re, 'id-42')).toMatchObject({ ok: true, matched: true });
    expect(safeTest(re, 'id-x')).toMatchObject({ ok: true, matched: false });
  });
});
