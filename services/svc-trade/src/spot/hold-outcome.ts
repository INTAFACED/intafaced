import { LedgerError } from '@intafaced/ledger-client';

/**
 * Seconds after the last hold attempt before an absent `order.hold` key may
 * be treated as dead. Same bound svc-bank uses before it releases collateral
 * for a pending loan (`LOAN_ATTEMPT_IN_FLIGHT_BOUND_SECONDS`,
 * services/svc-bank/src/loans/loan-service.ts:150-165): 25s caller retry
 * deadline + 300s signature skew + one 15s statement + 60s idle-in-transaction,
 * rounded up to 7 minutes. Those last two terms are the ledger pool limits in
 * services/svc-ledger/src/db/connection-options.ts:31-52. Evidence, not proof:
 * the sum does not bound time an accepted post spends queued in the pool.
 */
export const HOLD_UNKNOWN_IN_FLIGHT_BOUND_SECONDS = 7 * 60;

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
  // The caller binding refuses these before the post reaches the book (svc-ledger `s2s-http.ts`).
  'ledger.caller_unbound',
  'ledger.caller_forbidden',
]);

/** Undici reports these on `error.cause` when the socket never connected. */
const NEVER_SENT_CAUSE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

export type HoldPostClass = 'refused' | 'unsent' | 'unknown';

/**
 * A named ledger refusal, or a connect error proven to have happened before
 * any byte was sent, deletes the pending row. ECONNRESET, socket hang up,
 * UND_ERR_SOCKET, any 5xx, and every other shape stay `unknown`.
 *
 * "Never sent" is only `cause.code` (undici), walked at most three levels.
 * A code on the error itself is not that proof.
 */
export function classifyHoldPostError(err: unknown): HoldPostClass {
  if (err instanceof LedgerError && DEFINITE_HOLD_REFUSAL_CODES.has(err.code)) return 'refused';
  if (causeNeverSent(err)) return 'unsent';
  return 'unknown';
}

function causeNeverSent(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 3; depth++) {
    if (current == null || typeof current !== 'object') return false;
    const cause = (current as { cause?: unknown }).cause;
    if (cause == null || typeof cause !== 'object') return false;
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string' && NEVER_SENT_CAUSE_CODES.has(code)) return true;
    current = cause;
  }
  return false;
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
