import { describe, expect, it } from 'vitest';
import { PREVIEW_LABEL, PREVIEW_REFUSAL_CODE, isPreviewRefusal, previewRefusal, previewRefusalSchema } from './preview-refusal.js';
import * as root from './index.js';

const good = {
  kind: 'preview',
  code: PREVIEW_REFUSAL_CODE,
  engine: 'bank.loan_schedule',
  action: 'change_repayment_date',
  label: PREVIEW_LABEL,
};

describe('preview refusal', () => {
  it('builds the full refusal with the label', () => {
    expect(previewRefusal('bank.loan_schedule', 'change_repayment_date')).toEqual(good);
    expect(PREVIEW_LABEL).toBe('Preview · sample data');
  });

  it('refuses a wrong kind, an allowlist code, an extra key, bad ids and a wrong label', () => {
    expect(previewRefusalSchema.safeParse({ ...good, kind: 'not_connected' }).success).toBe(false);
    expect(previewRefusalSchema.safeParse({ ...good, code: 'vendor.email' }).success).toBe(false);
    expect(previewRefusalSchema.safeParse({ ...good, extra: 1 }).success).toBe(false);
    expect(previewRefusalSchema.safeParse({ ...good, engine: 'Loan Schedule' }).success).toBe(false);
    expect(previewRefusalSchema.safeParse({ ...good, action: 'Change-Date' }).success).toBe(false);
    expect(previewRefusalSchema.safeParse({ ...good, label: 'Preview' }).success).toBe(false);
    expect(() => previewRefusal('bank', 'x')).toThrow();
  });

  it('tells a preview refusal from a NotConnected', () => {
    expect(isPreviewRefusal(previewRefusal('bank.loan_schedule', 'pay_extra'))).toBe(true);
    expect(isPreviewRefusal({ status: 'not_connected', notConnected: 'vendor.kyc' })).toBe(false);
  });

  it('is exported from the package root', () => {
    expect(root.previewRefusalSchema).toBe(previewRefusalSchema);
  });
});
