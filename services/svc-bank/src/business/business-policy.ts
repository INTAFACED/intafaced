/**
 * bank.business product policy — maker/checker dual control honesty.
 *
 * Threshold is per-account owner law; this door never invents a default amount.
 */
export const BUSINESS_ROLES = ['admin', 'maker', 'checker'] as const;

export type BusinessPolicySummary = ReturnType<typeof describeBusinessPolicy>;

export const BUSINESS_PAYROLL_RATE_UNSET = 'bank.business_payroll_rate_unset' as const;

/** Public honesty board for bank.business — dual control + hold-before-approve + atomic payroll. */
export function describeBusinessPolicy() {
  return {
    roles: BUSINESS_ROLES,
    dualControlOverThreshold: true as const,
    holdBeforeCheckerApprove: true as const,
    makerCannotSelfApprove: true as const,
    thresholdPerAccountOwnerLaw: true as const,
    inventsDefaultThreshold: false as const,
    underThresholdPostsImmediately: true as const,
    payrollAtomicAllOrNothing: true as const,
    payrollSameAssetOnly: true as const,
    inventsPayrollRates: false as const,
    payrollRateUnsetCode: BUSINESS_PAYROLL_RATE_UNSET,
    closeNeedsSecondAdmin: true as const,
    thresholdChangeNeedsSecondAdmin: true as const,
    memberHandlesFromIdentity: true as const,
    approvalHistoryUsesHandles: true as const,
  };
}
