/**
 * bank.business product policy — maker/checker dual control honesty.
 *
 * Threshold is per-account owner law; this door never invents a default amount.
 */
export const BUSINESS_ROLES = ['admin', 'maker', 'checker', 'signer', 'editor', 'viewer', 'security_auditor', 'non_signing_admin'] as const;

export type BusinessMemberRole = (typeof BUSINESS_ROLES)[number];

/**
 * What a role may do, in one table (W-security-accounts-04). Every server check asks for a
 * capability, never a role name, so a viewer is refused approve and sign in one place.
 *
 *   view         read the account, its approvals and its team
 *   propose      start a payment or payroll (the initiator)
 *   approve      decide a waiting payment (the approver; `checker` is that role)
 *   sign         the last step of a withdrawal (the signer); no transfer here has a sign step
 *   manage_team  add, re-role and remove members; confirm account controls
 *
 * `non_signing_admin` is `admin` without `sign`. `editor` can start payments but never decide
 * them. `security_auditor` and `viewer` are read-only.
 */
export const BUSINESS_CAPABILITIES = ['view', 'propose', 'approve', 'sign', 'manage_team'] as const;
export type BusinessCapability = (typeof BUSINESS_CAPABILITIES)[number];

export const BUSINESS_ROLE_CAPABILITIES: Readonly<Record<BusinessMemberRole, readonly BusinessCapability[]>> = {
  admin: ['view', 'propose', 'approve', 'sign', 'manage_team'],
  non_signing_admin: ['view', 'propose', 'approve', 'manage_team'],
  maker: ['view', 'propose'],
  editor: ['view', 'propose'],
  checker: ['view', 'approve'],
  signer: ['view', 'sign'],
  viewer: ['view'],
  security_auditor: ['view'],
};

export function roleCan(role: BusinessMemberRole, capability: BusinessCapability): boolean {
  return BUSINESS_ROLE_CAPABILITIES[role].includes(capability);
}

/** The roles that hold a capability, in table order, for an error message. */
export function rolesWith(capability: BusinessCapability): BusinessMemberRole[] {
  return BUSINESS_ROLES.filter((role) => roleCan(role, capability));
}

/**
 * One person may not hold two of the duties on the same request: the initiator, the approver
 * and the signer are three different people. Absent duties are not compared. Returns the first
 * clash so the caller can refuse with a typed error.
 */
export function dutyClash(duties: {
  readonly initiator?: string | null;
  readonly approver?: string | null;
  readonly signer?: string | null;
}): 'initiator_approver' | 'initiator_signer' | 'approver_signer' | null {
  const { initiator, approver, signer } = duties;
  if (initiator && approver && initiator === approver) return 'initiator_approver';
  if (initiator && signer && initiator === signer) return 'initiator_signer';
  if (approver && signer && approver === signer) return 'approver_signer';
  return null;
}

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
