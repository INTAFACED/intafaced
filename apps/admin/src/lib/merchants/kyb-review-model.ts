/** Shared by the Verification tab's forms and its route: the bounds svc-pay puts on a rejection reason. */
export const KYB_REASON_MIN = 3;
export const KYB_REASON_MAX = 1000;

/** Characters as people count them (code points), the way svc-pay checks the stored reason. */
export const reasonLength = (text: string): number => [...text].length;

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

/** Shared by the information-request forms and their route: the bounds svc-pay puts on a request and a closing note. */
export const KYB_REQUEST_TEXT_MAX = 2000;
export const KYB_CLOSE_NOTE_MAX = 1000;

/** svc-pay's idempotency key for a request: the same merchant, words and due date are the same request. */
export async function kybRequestKey(merchantId: string, text: string, dueAt: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${merchantId}\n${text}\n${dueAt}`)));
  const hex = Array.from(digest.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
  return `kyb-request:${merchantId}:${hex}`;
}

export const KYB_REQUEST_STATE_WORDS: Record<string, string> = { open: 'Open', answered: 'Answered', closed: 'Closed' };
