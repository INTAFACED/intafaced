/**
 * Launch refusal codes (J-more-catalogue-11) and their one plain sentence each.
 * No price, cap or weight is written here.
 */
export const LAUNCH_REFUSAL_COPY = {
  'launch.event_not_found': 'We could not find that launch.',
  'launch.issuer_not_found': 'We could not find that issuer.',
  'launch.issuer_not_onboarded': 'This issuer has not finished review, so its launch cannot go ahead.',
  'launch.issuer_move_invalid': 'The issuer cannot move to that state from where it is.',
  'launch.issuer_conflict': 'That issuer id is already taken by another name.',
  'launch.event_conflict': 'That launch id is already used for a different launch.',
  'launch.event_move_invalid': 'The launch cannot move to that status from where it is.',
  'launch.event_stale': 'This launch changed since you read it. Read it again.',
  'launch.issuer_stale': 'This issuer changed since you read it. Read it again.',
  'launch.period_not_due': 'That period of the launch has not started yet.',
  'launch.period_passed': 'That period of the launch is already over.',
  'launch.allocation_unwired': 'Allocation and distribution have no ledger recipe wired, so the launch cannot move past closed.',
  'launch.event_invalid': 'The launch details are not valid.',
  'launch.events_list_limit_unset': 'A page size is required.',
  'launch.min_kyc_tier_unset': 'Who may take part is not set: the least identity verification is blank.',
  'launch.restricted_regions_unset': 'Who may take part is not set: the barred regions are blank.',
  'launch.eligibility_unavailable': 'We could not read your account to check who may take part. Try again later.',
} as const;

export type LaunchErrorCode = keyof typeof LAUNCH_REFUSAL_COPY;

export class LaunchError extends Error {
  constructor(
    message: string,
    readonly code: LaunchErrorCode,
  ) {
    super(message);
    this.name = 'LaunchError';
  }
}

export function launchCopy(code: LaunchErrorCode): string {
  return LAUNCH_REFUSAL_COPY[code];
}
