import { describe, expect, it } from 'vitest';
import { BUSINESS_ROLES, describeBusinessPolicy } from './business-policy.js';

describe('describeBusinessPolicy — bank.business honesty door', () => {
  it('states maker/checker dual control without inventing thresholds', () => {
    const p = describeBusinessPolicy();
    expect(p.roles).toEqual(BUSINESS_ROLES);
    expect(p.dualControlOverThreshold).toBe(true);
    expect(p.holdBeforeCheckerApprove).toBe(true);
    expect(p.makerCannotSelfApprove).toBe(true);
    expect(p.inventsDefaultThreshold).toBe(false);
    expect(p.underThresholdPostsImmediately).toBe(true);
  });

  it('names threshold as per-account owner law', () => {
    const p = describeBusinessPolicy();
    expect(p.thresholdPerAccountOwnerLaw).toBe(true);
    expect(p.inventsDefaultThreshold).toBe(false);
  });

  it('payroll is atomic, same-asset, and does not invent rates', () => {
    const p = describeBusinessPolicy();
    expect(p.payrollAtomicAllOrNothing).toBe(true);
    expect(p.payrollSameAssetOnly).toBe(true);
    expect(p.inventsPayrollRates).toBe(false);
    expect(p.payrollRateUnsetCode).toBe('bank.business_payroll_rate_unset');
    expect(p.closeNeedsSecondAdmin).toBe(true);
    expect(p.thresholdChangeNeedsSecondAdmin).toBe(true);
    expect(p.memberHandlesFromIdentity).toBe(true);
    expect(p.approvalHistoryUsesHandles).toBe(true);
  });
});
