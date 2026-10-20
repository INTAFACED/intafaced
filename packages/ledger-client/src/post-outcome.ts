import { LedgerError } from './types.js';

/**
 * What a failed `ledger.post` proves about the movement under its idempotency key.
 *
 *   `refused`  the ledger refused it before committing anything. The key is free and the caller may release its claim.
 *   `unsent`   the request never left this process (the connection was never made). Same consequence as `refused`.
 *              Only ever returned when the post had a single attempt.
 *   `unknown`  anything else. The post may have committed and only the reply was lost, or it may not have. Keep the
 *              claim, read the key back (`getTxByKey`) and decide from the book.
 */
export type PostOutcomeClass = 'refused' | 'unsent' | 'unknown';

/**
 * Codes the ledger engines raise only AFTER they have looked the key up. Both engines look the key up first
 * (`postgres-ledger.ts`, STOP §4.2b #4), so a key that already committed returns its transaction and never reaches one
 * of these. A reply that carries one of them therefore proves nothing committed under this key.
 *
 * Deliberately NOT here:
 *  - `ledger.idempotency_conflict` proves the opposite: the key already booked a movement and this body is a different
 *    one. That caller has an unknown outcome and must read the key before it decides anything.
 *  - `ledger.unauthenticated` and `ledger.recipe_required` are raised by the HTTP door (`s2s-http.ts`, `router.ts`)
 *    BEFORE `post` runs, so before the key is looked up. A post that committed and lost its reply can be refused with
 *    either when the caller's key is rotated or the recipe gate changes before the retry.
 *  - `ledger.freeze_attributed` is raised by freeze writes, never by a post.
 * Every code not listed is `unknown` for the same reason: only a named engine refusal is proof.
 */
export const DEFINITE_POST_REFUSAL_CODES: ReadonlySet<string> = new Set([
  'ledger.insufficient_funds',
  'ledger.invalid_entry',
  'ledger.unbalanced',
  'ledger.owner_identity_space',
  'ledger.frozen',
]);

/** Undici reports these on `error.cause` when the socket never connected. */
const NEVER_SENT_CAUSE_CODES: ReadonlySet<string> = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

/** Property the HTTP client stamps on an error it gives up with: how many attempts had started. */
export const POST_ATTEMPTS_FIELD = 'ledgerPostAttempts';

/** Records on a thrown error how many attempts the transport had started. Never throws; ignores non-objects. */
export function stampPostAttempts(err: unknown, attempts: number): void {
  if (err === null || typeof err !== 'object' || attempts < 1) return;
  try {
    Object.defineProperty(err, POST_ATTEMPTS_FIELD, { value: attempts, enumerable: false, configurable: true });
  } catch {
    // A frozen error simply carries no count, which reads as "unknown number of attempts" below.
  }
}

function attemptsOf(err: unknown): number | null {
  if (err === null || typeof err !== 'object') return null;
  const n = (err as Record<string, unknown>)[POST_ATTEMPTS_FIELD];
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : null;
}

export interface PostOutcomeOptions {
  /**
   * The caller knows it made exactly ONE attempt, and no earlier post under this key. Needed only for a transport that
   * does not stamp its attempt count; the shared HTTP client does, and an error that carries a count of 1 is treated
   * the same way.
   */
  readonly singleAttempt?: boolean;
}

/**
 * Sort a post failure into `refused`, `unsent` or `unknown` by what the REPLY says.
 *
 * "Never sent" is only `cause.code` (undici), walked at most three levels, and only for a single attempt. A code on the
 * error itself is not that proof. ECONNRESET, socket hang up, UND_ERR_SOCKET, every 5xx, a timeout and every untyped
 * error stay `unknown`.
 *
 * This is the class of the LAST attempt. Whether it frees the claim also depends on how many attempts there were
 * and whether the key was posted before: `provesPostNotCommitted`.
 */
export function classifyPostOutcome(err: unknown, options: PostOutcomeOptions = {}): PostOutcomeClass {
  if (err instanceof LedgerError && DEFINITE_POST_REFUSAL_CODES.has(err.code)) return 'refused';
  if (isSingleAttempt(err, options) && causeNeverSent(err)) return 'unsent';
  return 'unknown';
}

function isSingleAttempt(err: unknown, options: PostOutcomeOptions): boolean {
  return options.singleAttempt === true || attemptsOf(err) === 1;
}

/**
 * True when the failure proves nothing committed under the key, so the caller may release its claim.
 *
 * Only a call that made a SINGLE attempt, and is the FIRST post ever made under this key, proves it (stamped count of 1,
 * or `singleAttempt: true`):
 *   - The shared HTTP client retries a post after a network error or a 502/503/504 and throws only the LAST attempt's
 *     error. An earlier attempt that timed out on the caller's side may still be queued on the ledger and commit later,
 *     so a refusal or failed connect from attempt 2 proves nothing about attempt 1. A retried or uncounted call is
 *     never released from its error alone.
 *   - The count covers one call, not the key. A caller that re-posts under a key it already posted once (the lost-reply
 *     flow) must not use this at all: its earlier call may still land. It keeps the claim, reads the key back
 *     (`getTxByKey`) once `POST_IN_FLIGHT_BOUND_SECONDS` have passed since its LAST attempt, and decides from the book.
 */
export function provesPostNotCommitted(err: unknown, options: PostOutcomeOptions = {}): boolean {
  return classifyPostOutcome(err, options) !== 'unknown' && isSingleAttempt(err, options);
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

/**
 * Seconds after the last attempt before an absent key may be treated as dead (the post can no longer land).
 * 25s caller retry deadline + 300s signature skew + one 15s statement + 60s idle-in-transaction, rounded up to 7
 * minutes. The last two terms are the ledger pool limits in `services/svc-ledger/src/db/connection-options.ts`.
 * Evidence, not proof: the sum does not bound time an accepted post spends queued in the pool.
 */
export const POST_IN_FLIGHT_BOUND_SECONDS = 7 * 60;
