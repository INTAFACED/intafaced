/**
 * The Market listing page's pure parts (MC-market-01): which of my purchases may review a listing, and the review's
 * business key.
 */

export type ReviewablePurchase = { id: string; listingId: string; status: string; createdAt?: string };

/** Only a purchase whose money reached the seller may review: settled (pay-through) or released (held, then paid). */
export const REVIEWABLE_STATUSES: readonly string[] = ['settled', 'released'];

/** My newest purchase of this listing that may review it, or null (svc-market refuses the rest `market.review_not_settled`). */
export function reviewablePurchase<T extends ReviewablePurchase>(rows: readonly T[], listingId: string): T | null {
  const own = rows.filter((row) => row.listingId === listingId && REVIEWABLE_STATUSES.includes(row.status));
  own.sort((a, b) => Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? ''));
  return own[0] ?? null;
}

/** FNV-1a, 32 bits, as 8 hex digits: a short, stable digest of the review text for its key. */
function digest(text: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * The review's business key: the purchase, the score and the text. Sending the same review again (a lost reply) reuses
 * the key, so svc-market returns the stored one; a different review of the same purchase is a new key, which the service
 * refuses as `market.review_exists`.
 */
export function reviewKey(purchaseId: string, score: number, text: string): string {
  return `review:${purchaseId}:${score}:${digest(text.trim())}`;
}
