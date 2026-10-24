/** Shared by the Verification tab's forms and its route: the bounds svc-pay puts on a rejection reason. */
export const KYB_REASON_MIN = 3;
export const KYB_REASON_MAX = 1000;

/** The merchant reads these words next to each document (apps/customer: Needed, Pending, Verified, Invalid). */
export const KYB_DOCUMENT_STATE_WORDS: Record<string, string> = {
  missing: 'Not sent',
  provided: 'Waiting for review',
  accepted: 'Verified',
  rejected: 'Invalid',
};

/** Document keys are short names (`test_proof_of_address`); shown as words ("Test proof of address"). */
export function documentWords(key: string): string {
  const words = key.replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
