import { describe, expect, it } from 'vitest';
import { classifyAccount, classifyBic } from './account-format.js';

describe('account format', () => {
  it('accepts the published IBAN checksum and rejects a one-digit change', () => {
    expect(classifyAccount('GB82 WEST 1234 5698 7654 32')).toEqual({
      ok: true,
      kind: 'iban',
      normalized: 'GB82WEST12345698765432',
    });
    expect(classifyAccount('GB82WEST12345698765433').ok).toBe(false);
  });

  it('accepts an IFSC and a digit account number, and a BIC shape', () => {
    const ifsc = classifyAccount('HDFC0001234');
    const digits = classifyAccount('123456789');
    expect(ifsc.ok && ifsc.kind).toBe('ifsc');
    expect(digits.ok && digits.kind).toBe('account_number');
    expect(classifyAccount('not an account').ok).toBe(false);
    expect(classifyBic('deutdeff')).toEqual({ ok: true, normalized: 'DEUTDEFF' });
    expect(classifyBic('DEUT').ok).toBe(false);
  });
});
