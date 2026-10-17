import { LedgerError } from '@intafaced/ledger-client';

/**
 * Idempotency key `recipes.orderHold` posts.
 * Read this key back after an unknown post. Do not invent a second key.
 */
export function orderHoldIdempotencyKey(orderId: string): string {
  return `order.hold:${orderId}`;
}

/**
 * The ledger named these codes because the post was refused before commit.
 * A timeout, a dropped connection, or any error without one of these codes
 * can mean the hold was booked and the reply was lost.
 */
const DEFINITE_HOLD_REFUSAL_CODES = new Set([
  'ledger.insufficient_funds',
  'ledger.invalid_entry',
  'ledger.unbalanced',
  'ledger.owner_identity_space',
  'ledger.frozen',
  'ledger.unauthenticated',
  'ledger.freeze_attributed',
]);

export type HoldPostClass = 'refused' | 'unknown';

/** Refusal deletes the pending row. Anything else stays until the key is read. */
export function classifyHoldPostError(err: unknown): HoldPostClass {
  if (err instanceof LedgerError && DEFINITE_HOLD_REFUSAL_CODES.has(err.code)) return 'refused';
  return 'unknown';
}

export type HoldRead = 'present' | 'absent' | 'unknown';

export interface HoldUnknownAlert {
  readonly orderId: string;
  readonly resolution: 'still_unknown' | 'booked' | 'absent';
  readonly detail: string;
}

export interface HoldUnknownSweepResult {
  readonly examined: number;
  readonly booked: readonly string[];
  readonly absent: readonly string[];
  readonly stillUnknown: readonly string[];
  readonly alerts: readonly HoldUnknownAlert[];
}
