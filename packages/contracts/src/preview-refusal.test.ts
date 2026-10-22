import { describe, expect, it } from 'vitest';
import * as root from './index.js';
import { PREVIEW_LABEL, PREVIEW_REFUSAL_CODE, isPreviewRefusal, previewRefusal, previewRefusalSchema } from './preview-refusal.js';

const built = previewRefusal('bank.loan_schedule', 'change_repayment_date');

describe('typed Preview refusal (BK-loan-09, IA-SPEC 3.3)', () => {
  it('builds the full refusal with code and label', () => {
    expect(built).toEqual({
      kind: 'preview',
      code: 'preview.engine_not_built',
      engine: 'bank.loan_schedule',
      action: 'change_repayment_date',
      label: 'Preview · sample data',
    });
    expect(PREVIEW_REFUSAL_CODE).toBe('preview.engine_not_built');
    expect(PREVIEW_LABEL).toBe('Preview · sample data');
  });
  it('refuses a NotConnected kind, an allowlist code, extra keys, bad engine, bad action and wrong label', () => {
    for (const change of [
      { kind: 'not_connected' },
      { code: 'vendor.email' },
      { notConnected: 'rail.bank' },
      { engine: 'Loan Schedule' },
      { engine: 'loan_schedule' },
      { action: 'Change-Date' },
      { label: 'Preview' },
    ])
      expect(previewRefusalSchema.safeParse({ ...built, ...change }).success).toBe(false);
    expect(() => previewRefusal('bank', 'repay')).toThrow();
  });
  it('isPreviewRefusal tells it apart from a NotConnected', () => {
    expect(isPreviewRefusal(built)).toBe(true);
    expect(isPreviewRefusal({ status: 'not_connected', notConnected: 'vendor.kyc' })).toBe(false);
  });
  it('is exported from the package root', () => {
    expect(root.previewRefusalSchema).toBe(previewRefusalSchema);
  });
});
