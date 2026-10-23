/**
 * The terms an account tier carries, in identity's order (`ACCOUNT_TIER_TERM_KEYS` in contracts). Kept here because the
 * contracts package cannot be bundled into a browser component; a test pins the two lists equal.
 */
export const TIER_TERM_KEYS = ['ratePercent', 'monthlyFee', 'feeAssetId', 'dailyLimit', 'clearingDays'] as const;
export type TierTermKey = (typeof TIER_TERM_KEYS)[number];

export const TIER_TERM_LABEL: Readonly<Record<TierTermKey, string>> = {
  ratePercent: 'Rate (% a year)',
  monthlyFee: 'Monthly fee',
  feeAssetId: 'Fee and limit asset',
  dailyLimit: 'Daily limit',
  clearingDays: 'Clearing (days)',
};
