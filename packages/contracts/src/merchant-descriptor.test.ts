import { describe, expect, it } from 'vitest';
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
});
