/**
 * The numbers and wording choices behind the new CRM screens, in one place so Nitro can change them without reading screens.
 * Nothing here is enforced by the server: the reply targets only colour a waiting time, and the raise target only sizes a bar.
 */

/**
 * How long a person may wait for a first reply before their waiting time turns amber (past the target) and then red (past
 * twice the target). Business days: Saturday and Sunday do not count. Internal only; the public page promises no deadline.
 */
export const REPLY_TARGET_BUSINESS_DAYS = {
  investor: 1, // Nitro to confirm
  other: 3, // Nitro to confirm
} as const;

/** What the Raise bar is measured against, an exact decimal string in euros. Only committed euros fill it. */
export const RAISE_TARGET_EUR = '5000000';

/** The currency a new commitment starts in. */
export const DEFAULT_COMMITMENT_CURRENCY = 'EUR';
/** Offered as one-tap currencies; any other ISO 4217 code can be typed and the server checks it. */
export const COMMON_CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'SGD', 'AED'] as const;

/** Mark replied: what is recorded when the founder presses it once. All of it can be changed with chips first. */
export const REPLY_REASON_DEFAULT = 'Replied by email';
export const REPLY_REASON_CHIPS = ['Replied by email', 'Replied by phone', 'Replied by message'] as const;
export const REPLY_NEXT_ACTION_DEFAULT = 'Wait for their reply';
export const REPLY_FOLLOW_UP_DAYS_DEFAULT = 5;

/** The next step presets (description) and the due presets (days from today, at 09:00 your time). */
export const NEXT_STEP_CHIPS = ['Wait for their reply', 'Schedule a call', 'Send follow-up', 'Review answers'] as const;
export const DUE_CHIPS = [
  { label: 'Tomorrow', days: 1 },
  { label: '+3 days', days: 3 },
  { label: 'Next week', days: 7 },
] as const;
/** The Mark replied due chips: the default five days sits between the two usual ones. */
export const REPLY_DUE_CHIPS = [
  { label: '+3 days', days: 3 },
  { label: '+5 days', days: 5 },
  { label: 'Next week', days: 7 },
] as const;

/** Stage change: reason chips instead of a typed reason. "Other…" reveals a text box. */
export const STAGE_REASON_CHIPS = ['Reviewed: fits', 'After call', 'Documents requested', 'Waiting for their reply'] as const;
export const OTHER_REASON = 'Other…';
/** Closing through the stage form (not a decline): evidence presets. */
export const CLOSE_EVIDENCE_CHIPS = ['Agreed on a call', 'Duplicate of another enquiry', 'Recorded by a founder'] as const;

/** Decline: each reason chip closes the enquiry with this outcome. */
export const DECLINE_REASONS = [
  { label: 'Not a fit now', disposition: 'declined' },
  { label: 'Round full', disposition: 'declined' },
  { label: 'Withdrawn by them', disposition: 'withdrawn' },
  { label: 'Waitlist', disposition: 'waitlisted' },
] as const;
export type DeclineReason = (typeof DECLINE_REASONS)[number]['label'];
export type Disposition = 'proceeded' | 'declined' | 'withdrawn' | 'waitlisted' | 'duplicate';
export const DISPOSITIONS: readonly Disposition[] = ['proceeded', 'declined', 'withdrawn', 'waitlisted', 'duplicate'];
export const DISPOSITION_LABEL: Record<Disposition, string> = {
  proceeded: 'Proceeded',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
  waitlisted: 'Waitlisted',
  duplicate: 'Duplicate',
};

/** Commitment: the reason chips, and the longest evidence note and reason the contract accepts. */
export const COMMITMENT_REASON_CHIPS = ['After the call', 'Documents signed', 'Verbal yes', 'Correction'] as const;
export const COMMITMENT_EVIDENCE_MAX = 200;
export const COMMITMENT_REASON_MAX = 500;

/** The two business rules the contract sets on text, repeated here so a sheet can stop a long entry before the server does. */
export const LIMITS = {
  reason: 500,
  closingEvidence: 256,
  interactionReason: 2000,
  nextActionDescription: 160,
  note: 2000,
} as const;
