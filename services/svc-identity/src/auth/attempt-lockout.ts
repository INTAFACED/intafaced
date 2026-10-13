import type { Sql } from 'postgres';
import { AuthError } from './auth-service.js';

/**
 * PER-ACCOUNT SIGN-IN ATTEMPT LOCKOUT.
 *
 * Failure this prevents: online guessing. A 6-digit TOTP code has only a million
 * values (and a ±1 step window); a distributed attacker who knows an identifier
 * (and, for MFA, the password) can try them from thousands of IPs. The edge
 * limiter (svc-edge, per-IP, in memory) cannot see that: it is keyed on the
 * source address and is not shared between replicas. The same applies to
 * credential stuffing against one account from many addresses. This limiter is
 * keyed on the ACCOUNT and lives in Postgres, so it is shared by every replica
 * and survives restarts.
 *
 * Two independent counters per user (table `auth_attempts`, PK user_id + kind):
 *  - `password`: wrong passwords at login.
 *  - `mfa`: wrong TOTP / recovery codes, at login and at step-up together
 *    (recovery codes are a second route into the same factor, so they share
 *    the budget; otherwise they would double an attacker's guesses).
 * They are separate on purpose: exhausting the password counter does not lock
 * the step-up of an already signed-in user, and the mfa counter only ever
 * moves for someone who already passed the password check at login.
 *
 * RESERVE-THEN-VERIFY. The guess is counted BEFORE it is checked, by one atomic
 * UPSERT (`reserveAttempt`). Counting after the check ("record the failure")
 * would let an attacker fire 50 guesses in parallel: every one would pass the
 * "not locked yet" test before the first failure was written. With a reserve,
 * the database serialises the increments on the row, so at most `maxFailures`
 * guesses are ever verified inside a window, however many arrive at once. A
 * locked account is refused before any code is verified, so a refused attempt
 * never consumes a TOTP step or a recovery code. A successful sign-in calls
 * `recordSuccess`, which clears the row (the reservation is, in effect,
 * refunded). Any other exit (wrong code, replay, crash) leaves the count
 * standing, which is the safe default.
 *
 * KNOWN TRADE-OFFS (accepted):
 *  - Anyone who knows an identifier can keep that account's password logins
 *    refused by sending wrong passwords. The effect is bounded to LOCK_SECONDS
 *    after the last lock and does not touch money movement of existing sessions.
 *  - A correct password while the account is locked is also refused.
 *  - Whoever holds the password can lock the mfa counter, which delays that
 *    user's step-up for up to LOCK_SECONDS.
 *  - A locked account answers `auth.too_many_attempts`, an unknown identifier
 *    answers `auth.invalid_credentials`: after the threshold the two differ,
 *    which confirms the account exists. Unknown identifiers keep no state, so
 *    this cannot be closed without storing rows for identifiers that do not
 *    exist. Handles are public in this product.
 *  - A legitimate success clears the counter, so an attacker interleaving with
 *    the owner's successful sign-ins gets at most `maxFailures` fresh guesses
 *    per owner success.
 */
export type AttemptKind = 'password' | 'mfa';

export interface AttemptPolicy {
  /** Failures allowed inside one window. The attempt that reaches this number locks the account. */
  readonly maxFailures: number;
  /** A failure older than this no longer counts; the next one starts a new window. */
  readonly windowSeconds: number;
  /** How long the account refuses this kind of attempt once locked. Fixed (no escalation). */
  readonly lockSeconds: number;
}

/** The one place the numbers live. */
export const ATTEMPT_POLICY: Readonly<Record<AttemptKind, AttemptPolicy>> = {
  password: { maxFailures: 10, windowSeconds: 15 * 60, lockSeconds: 15 * 60 },
  mfa: { maxFailures: 5, windowSeconds: 10 * 60, lockSeconds: 15 * 60 },
};

function tooManyAttempts(retryAfterSeconds: number): AuthError {
  // No counts, thresholds or kind in the message: it must not help tune a guess budget.
  return new AuthError('Too many attempts. Try again later.', 'auth.too_many_attempts', { retryAfterSeconds });
}

/**
 * Count one attempt for (user, kind) and refuse if the account is locked.
 * Single atomic statement; call it BEFORE verifying the secret.
 *
 *  - no row, or the window / previous lock has expired: start a new window at 1;
 *  - otherwise: failures + 1;
 *  - when the new count reaches `maxFailures`: set `locked_until`. This
 *    attempt is still verified (it is the last permitted guess); the next is refused;
 *  - row currently locked: the WHERE clause makes the UPSERT a no-op, no row
 *    comes back, and we throw without touching the count.
 */
export async function reserveAttempt(sql: Sql, userId: string, kind: AttemptKind, now: Date = new Date()): Promise<void> {
  const { maxFailures, windowSeconds, lockSeconds } = ATTEMPT_POLICY[kind];
  const stale = sql`(a.locked_until <= ${now}::timestamptz OR a.window_started_at <= ${now}::timestamptz - make_interval(secs => ${windowSeconds}::int))`;
  const next = sql`(CASE WHEN ${stale} THEN 1 ELSE a.failures + 1 END)`;
  const reserved = await sql<Array<{ failures: number }>>`
    INSERT INTO auth_attempts AS a (user_id, kind, failures, window_started_at, locked_until, updated_at)
    VALUES (
      ${userId}, ${kind}, 1, ${now}::timestamptz,
      CASE WHEN 1 >= ${maxFailures}::int THEN ${now}::timestamptz + make_interval(secs => ${lockSeconds}::int) END,
      ${now}::timestamptz
    )
    ON CONFLICT (user_id, kind) DO UPDATE SET
      failures = ${next},
      window_started_at = CASE WHEN ${stale} THEN ${now}::timestamptz ELSE a.window_started_at END,
      locked_until = CASE WHEN ${next} >= ${maxFailures}::int THEN ${now}::timestamptz + make_interval(secs => ${lockSeconds}::int) END,
      updated_at = ${now}::timestamptz
    WHERE a.locked_until IS NULL OR a.locked_until <= ${now}::timestamptz
    RETURNING failures`;
  if (reserved.length > 0) return;
  const rows = await sql<Array<{ locked_until: Date | null }>>`
    SELECT locked_until FROM auth_attempts WHERE user_id = ${userId} AND kind = ${kind}`;
  const until = rows[0]?.locked_until;
  const seconds = until ? Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000)) : lockSeconds;
  throw tooManyAttempts(seconds);
}

/**
 * Read-only check: throws `auth.too_many_attempts` while locked, never changes state.
 * (`reserveAttempt` already includes this; it is for callers that must refuse
 * without counting.)
 */
export async function assertNotLocked(sql: Sql, userId: string, kind: AttemptKind, now: Date = new Date()): Promise<void> {
  const rows = await sql<Array<{ locked_until: Date | null }>>`
    SELECT locked_until FROM auth_attempts WHERE user_id = ${userId} AND kind = ${kind}`;
  const until = rows[0]?.locked_until;
  if (until && until.getTime() > now.getTime()) {
    throw tooManyAttempts(Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000)));
  }
}

/**
 * Clear the counters for a user after the credential was verified. Because
 * `reserveAttempt` counts before verifying, this is what turns a reservation
 * into "not a failure".
 */
export async function recordSuccess(sql: Sql, userId: string, ...kinds: AttemptKind[]): Promise<void> {
  if (kinds.length === 0) return;
  await sql`DELETE FROM auth_attempts WHERE user_id = ${userId} AND kind IN ${sql(kinds)}`;
}
