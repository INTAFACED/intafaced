/** Cancel-all bookkeeping: every row lands in exactly one honest bucket. */
export type CancelBucket = 'cancelled' | 'refused' | 'unconfirmed' | 'notSent';

export type CancelRow = { id: string; symbol: string; bucket: CancelBucket; text: string };

export type CancelCounts = Record<CancelBucket, number> & { total: number };

/**
 * `total` is how many orders the run set out to cancel. Orders the run never reached (it stops after a
 * blocked or unconfirmed answer) count as not sent, so the four buckets always add up to `total`.
 */
export function cancelCounts(rows: readonly CancelRow[], total: number): CancelCounts {
  const counts: CancelCounts = { cancelled: 0, refused: 0, unconfirmed: 0, notSent: 0, total };
  for (const row of rows) counts[row.bucket] += 1;
  counts.notSent += Math.max(0, total - rows.length);
  return counts;
}

/** Buckets that need the customer's attention, in the order the summary should say them. */
export const CANCEL_BUCKET_ORDER: readonly CancelBucket[] = ['cancelled', 'refused', 'unconfirmed', 'notSent'];
