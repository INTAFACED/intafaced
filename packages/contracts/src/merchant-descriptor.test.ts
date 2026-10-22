import { describe, expect, it } from 'vitest';
import { merchantBusinessProfileSubmitInputSchema } from './merchant-portal.js';
import { MERCHANT_DESCRIPTOR_INVALID, merchantDescriptorProblem, merchantStatementDescriptorSchema } from './merchant-descriptor.js';

describe('statement descriptor validator (M-plat-org-09)', () => {
  it('accepts 5 to 22 allowed characters with a letter', () => {
    for (const v of ['SHOPS', 'TEST SHOP 2', 'A'.repeat(22), 'JOE & CO. LTD']) expect(merchantDescriptorProblem(v)).toBeNull();
  });
  it('names each problem', () => {
    expect(merchantDescriptorProblem('SHOP')).toBe('too_short');
    expect(merchantDescriptorProblem('A'.repeat(23))).toBe('too_long');
    for (const c of ['<', '>', '\\', "'", '"', '*', 'é']) expect(merchantDescriptorProblem(`SHOP${c}X`)).toBe('banned_character');
    expect(merchantDescriptorProblem('12345')).toBe('no_letter');
    expect(merchantDescriptorProblem(' SHOPS')).toBe('edge_whitespace');
  });
  it('schema refuses with merchant.descriptor_invalid', () => {
    expect(merchantStatementDescriptorSchema.safeParse('TEST SHOP').success).toBe(true);
    const r = merchantStatementDescriptorSchema.safeParse('SH*P');
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toBe(MERCHANT_DESCRIPTOR_INVALID);
  });
  it('refuses punctuation outside . , - &', () => {
    for (const c of ['#', '/', '(', ')', '+', ':', ';', '!', '?', '@', '_', '%', '$'])
      expect(merchantDescriptorProblem(`SHOP${c}X`)).toBe('banned_character');
    for (const c of ['.', ',', '-', '&']) expect(merchantDescriptorProblem(`SHOP${c}X`)).toBeNull();
  });
  it('whitespace-only input is edge_whitespace, not too_short', () => {
    expect(merchantDescriptorProblem('   ')).toBe('edge_whitespace');
  });
  it('the schema issue carries the problem', () => {
    const r = merchantStatementDescriptorSchema.safeParse('SHOP');
    expect(r.success).toBe(false);
    if (!r.success) expect((r.error.issues[0] as { params?: { problem?: string } }).params?.problem).toBe('too_short');
  });
  it('business profile submit uses the validator and lets blank clear it', () => {
    const base = { merchantId: '00000000-0000-4000-8000-000000000001', expectedVersion: '1', reason: 'update descriptor' };
    expect(merchantBusinessProfileSubmitInputSchema.safeParse({ ...base, statementDescriptor: 'TEST SHOP' }).success).toBe(true);
    expect(merchantBusinessProfileSubmitInputSchema.safeParse({ ...base, statementDescriptor: '' }).success).toBe(true);
    expect(merchantBusinessProfileSubmitInputSchema.safeParse({ ...base, statementDescriptor: null }).success).toBe(true);
    expect(merchantBusinessProfileSubmitInputSchema.safeParse(base).success).toBe(true);
    const bad = merchantBusinessProfileSubmitInputSchema.safeParse({ ...base, statementDescriptor: 'SH*P SHOP' });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues.some((i) => i.message === MERCHANT_DESCRIPTOR_INVALID)).toBe(true);
  });
});
