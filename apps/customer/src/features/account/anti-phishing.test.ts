import { describe, expect, it } from 'vitest';
import {
  antiPhishingCodeSchema,
  antiPhishingRefusal,
  antiPhishingSetResultSchema,
  antiPhishingStepUp,
  cleanAntiPhishingCode,
} from './anti-phishing';

describe('anti-phishing code in Security', () => {
  it('takes 4 to 20 letters and digits, trimmed, and nothing else', () => {
    expect(cleanAntiPhishingCode('  Owl42 ')).toBe('Owl42');
    expect(cleanAntiPhishingCode('A1b2')).toBe('A1b2');
    expect(cleanAntiPhishingCode('x'.repeat(20))).toBe('x'.repeat(20));
    for (const bad of ['abc', 'x'.repeat(21), 'with space', 'émoji1', 'owl-42', '']) expect(cleanAntiPhishingCode(bad)).toBeNull();
  });

  it('confirms the exact code and request id, and never names the code as the target', () => {
    const body = antiPhishingStepUp('Owl42', 'req-1');
    expect(body).toEqual({
      scope: 'identity.step_up.anti_phishing_set',
      purpose: 'account.antiPhishing.set',
      fields: { code: 'Owl42', clientRequestId: 'req-1' },
    });
    expect('target' in body).toBe(false);
    expect(antiPhishingStepUp('', 'req-2').fields.code).toBe('');
  });

  it("reads identity's answers", () => {
    expect(antiPhishingCodeSchema.parse({ code: null, updatedAt: null })).toEqual({ code: null, updatedAt: null });
    expect(antiPhishingSetResultSchema.parse({ code: 'Owl42', updatedAt: '2026-10-23T01:00:00.000Z', changed: true }).changed).toBe(true);
  });

  it("names identity's own refusals of the code and leaves every other answer to the general refusal", () => {
    const refused = (code: string, reason = 'error') => antiPhishingRefusal({ ok: false, reason, code, status: 400 });
    expect(refused('identity.anti_phishing_guessable')).toBe('refusedGuessable');
    expect(refused('identity.anti_phishing_invalid')).toBe('invalidCode');
    expect(refused('identity.anti_phishing_key_unset', 'error')).toBe('refusedKeyUnset');
    expect(refused('identity.anti_phishing_delegated', 'forbidden')).toBe('refusedDelegated');
    expect(refused('identity.step_up_target')).toBeNull();
    expect(refused('constructor')).toBeNull();
    expect(refused('identity.anti_phishing_guessable', 'uncertain')).toBeNull();
    expect(antiPhishingRefusal({ ok: true })).toBeNull();
  });
});
