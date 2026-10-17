import type { WriteOutcome } from '../rooms/write';

/** Cancel-all bookkeeping: every row lands in exactly one honest bucket. */
export type CancelBucket = 'cancelled' | 'refused' | 'unconfirmed' | 'notSent';

export type CancelRow = { id: string; symbol: string; bucket: CancelBucket; text: string };

export type CancelCounts = Record<CancelBucket, number> & { total: number; pending: number };

/**
 * `total` is how many orders the run set out to cancel. While the run is going (`running`), orders it has not reached yet
 * are `pending` ("still to go"). Once it has ended, orders it never reached (it stops after a blocked or unconfirmed
 * answer) count as not sent. Either way the four buckets plus `pending` always add up to `total`.
 */
export function cancelCounts(rows: readonly CancelRow[], total: number, { running = false }: { running?: boolean } = {}): CancelCounts {
  const counts: CancelCounts = { cancelled: 0, refused: 0, unconfirmed: 0, notSent: 0, pending: 0, total };
  for (const row of rows) counts[row.bucket] += 1;
  const unreached = Math.max(0, total - rows.length);
  if (running) counts.pending = unreached;
  else counts.notSent += unreached;
  return counts;
}

/**
 * Which bucket one cancel answer lands in, and whether the run stops after it. Only a verified `done` is cancelled and
 * only the service's own `refused` is refused; a lost answer is unconfirmed and a request that never left is not sent.
 * `idle` writes no row.
 */
export function bucketOf(outcome: WriteOutcome<unknown>): { bucket: CancelBucket | null; stop: boolean } {
  switch (outcome.kind) {
    case 'done':
      return { bucket: 'cancelled', stop: false };
    case 'refused':
      return { bucket: 'refused', stop: false };
    case 'blocked':
      return { bucket: 'notSent', stop: true };
    case 'uncertain':
      return { bucket: 'unconfirmed', stop: true };
    case 'idle':
      return { bucket: null, stop: true };
  }
}

/** Buckets that need the customer's attention, in the order the summary should say them. */
export const CANCEL_BUCKET_ORDER: readonly CancelBucket[] = ['cancelled', 'refused', 'unconfirmed', 'notSent'];
