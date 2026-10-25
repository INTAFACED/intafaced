/** The owner's reject reason list (IDENTITY_KYC_REJECT_REASONS, I-kyc-compliance-01): parsed at start, NO DEFAULT. */
import { describe, expect, it } from 'vitest';
import { KycCaseError, parseKycRejectReasons, requireRejectReason } from './cases.js';

const entry = (code: string, extra: Record<string, unknown> = {}) => ({ code, reason: 'TEST reason', guidance: 'TEST guidance', ...extra });
const parse = (value: unknown) => parseKycRejectReasons(JSON.stringify(value));

describe('parseKycRejectReasons', () => {
  it('unset or blank is an empty list, never a default one', () => {
    expect(parseKycRejectReasons(undefined).size).toBe(0);
    expect(parseKycRejectReasons('  ').size).toBe(0);
  });

  it('keeps each code with its reason and guidance', () => {
    const reasons = parse([entry('document_unreadable'), entry('name_mismatch', { reason: 'TEST other' })]);
    expect([...reasons.keys()]).toEqual(['document_unreadable', 'name_mismatch']);
    expect(reasons.get('name_mismatch')).toEqual({ code: 'name_mismatch', reason: 'TEST other', guidance: 'TEST guidance' });
  });

  it('stops the service on anything malformed', () => {
    for (const bad of [
      '{',
      '{}',
      '[]',
      JSON.stringify(['x']),
      JSON.stringify([entry('Upper')]),
      JSON.stringify([entry('a')]),
      JSON.stringify([entry('ok_code', { reason: '' })]),
      JSON.stringify([entry('ok_code', { guidance: ' ' })]),
      JSON.stringify([entry('ok_code', { reason: 'x'.repeat(201) })]),
      JSON.stringify([entry('ok_code', { guidance: 'x'.repeat(501) })]),
      JSON.stringify([entry('ok_code', { extra: 1 })]),
      JSON.stringify([entry('ok_code'), entry('ok_code')]),
    ])
      expect(() => parseKycRejectReasons(bad), bad).toThrow(/IDENTITY_KYC_REJECT_REASONS/);
  });
});

describe('requireRejectReason', () => {
  const thrown = (run: () => unknown) => {
    try {
      run();
    } catch (err) {
      return err;
    }
    return undefined;
  };

  it('refuses while the list is unset, and a code not on it', () => {
    const unset = thrown(() => requireRejectReason(new Map(), 'document_unreadable'));
    expect(unset).toBeInstanceOf(KycCaseError);
    expect((unset as KycCaseError).code).toBe('kyc.reason_codes_unset');
    const reasons = parse([entry('document_unreadable')]);
    expect((thrown(() => requireRejectReason(reasons, 'name_mismatch')) as KycCaseError).code).toBe('kyc.reason_code_unknown');
    expect(requireRejectReason(reasons, 'document_unreadable').reason).toBe('TEST reason');
  });
});
