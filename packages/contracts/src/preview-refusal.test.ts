import { describe, expect, it } from 'vitest';
import { BANK_LOAN_PREVIEW_ENGINES, isPreviewRefusal, previewRefusal, previewRefusalSchema } from './preview-refusal.js';

describe('typed Preview refusal (BK-loan-09, IA-SPEC 3.3)', () => {
  it('builds a preview refusal for each bank loan preview engine', () => {
    for (const engine of BANK_LOAN_PREVIEW_ENGINES) {
      const r = previewRefusal(engine, 'Change repayment date');
      expect(r).toMatchObject({ kind: 'preview', engine, action: 'Change repayment date' });
      expect(r.message).toMatch(/preview with sample data/);
      expect(isPreviewRefusal(r)).toBe(true);
    }
  });
  it('is never a NotConnected or allowlist shape', () => {
    const r = previewRefusal('loan_schedule', 'Repay');
    expect(previewRefusalSchema.safeParse({ ...r, code: 'rail.bank' }).success).toBe(false);
    expect(previewRefusalSchema.safeParse({ ...r, kind: 'not_connected' }).success).toBe(false);
    expect(isPreviewRefusal({ kind: 'not_connected', code: 'rail.bank' })).toBe(false);
  });
  it('refuses a bad engine key or empty action', () => {
    expect(() => previewRefusal('Loan Schedule', 'Repay')).toThrow();
    expect(() => previewRefusal('loan_schedule', '')).toThrow();
  });
});
