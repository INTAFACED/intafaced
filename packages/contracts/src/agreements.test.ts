import { describe, expect, it } from 'vitest';
import { AGREEMENT_KINDS, agreementRequiresInputSchema, agreementRequiresOutputSchema } from './agreements.js';

describe('agreements contract (RC-identity-12)', () => {
  it('names the fixed list of kinds', () => {
    expect(AGREEMENT_KINDS).toEqual([
      'trading',
      'custody',
      'margin',
      'market_data',
      'api',
      'rfq_block',
      'broker',
      'off_exchange_settlement',
    ]);
  });
  it('refuses an unknown kind or extra fields, and allows no published version', () => {
    const subjectId = '11111111-1111-4111-8111-111111111111';
    expect(agreementRequiresInputSchema.safeParse({ subjectId, kind: 'derivatives' }).success).toBe(false);
    expect(agreementRequiresInputSchema.safeParse({ subjectId, kind: 'api', extra: 1 }).success).toBe(false);
    expect(
      agreementRequiresOutputSchema.parse({ kind: 'api', currentVersion: null, acceptedVersion: null, required: false }).required,
    ).toBe(false);
  });
});
