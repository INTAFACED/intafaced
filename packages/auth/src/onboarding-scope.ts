/**
 * Merchant onboarding scope (`pay:onboard`).
 *
 * `merchant.create` cannot require `pay:write`: that scope is only granted
 * after KYB is approved, and KYB cannot be submitted until a merchant exists.
 * `pay:onboard` is the door for that loop. It is not an acquiring scope.
 *
 * `onboardingEligible` is the one predicate for the person. The founder has
 * not published a different rule; change it here and nowhere else.
 */

export type OnboardingUser = {
  /** `users.status`. Anything other than `active` is ineligible. */
  readonly accountStatus: string;
  /** True only when identity has a verification signal for the email. */
  readonly emailVerified: boolean;
  /** True when a TOTP secret or a security key is enrolled. */
  readonly secondFactorEnrolled: boolean;
};

/** Account active, email verified, and a second factor enrolled. */
export function onboardingEligible(user: OnboardingUser): boolean {
  return user.accountStatus === 'active' && user.emailVerified === true && user.secondFactorEnrolled === true;
}

export type OnboardingMerchant = {
  /** Set when this row is someone else's child. A child is not a root account. */
  readonly parentMerchantId: string | null;
  readonly status: 'pending' | 'active' | 'suspended' | 'closed';
} | null;

/**
 * `pay:onboard` for a person who may open or finish a root merchant.
 *
 * Granted when they are eligible and either have no merchant, or own a root
 * merchant that is pending or active (an approved owner is active or pending).
 * A child row, a suspended merchant, and a closed merchant are refused.
 * An empty list is the refusal; callers do not invent a second scope.
 */
export function issueMerchantOnboardingScope(input: {
  user: OnboardingUser;
  merchant: OnboardingMerchant;
}): readonly ['pay:onboard'] | readonly [] {
  if (!onboardingEligible(input.user)) return [];
  if (input.merchant === null) return ['pay:onboard'];
  if (input.merchant.parentMerchantId !== null) return [];
  if (input.merchant.status !== 'pending' && input.merchant.status !== 'active') return [];
  return ['pay:onboard'];
}
