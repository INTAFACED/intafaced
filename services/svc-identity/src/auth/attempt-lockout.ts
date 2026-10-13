import type { PendingQuery, Row, Sql } from 'postgres';
import { AuthError } from './auth-service.js';

/**
 * NOTE FOR FUTURE WIRING: the (currently unwired) `src/auth/redeem-recovery-*.ts`
 * modules verify recovery codes WITHOUT this counter. If any of them is ever
 * mounted on a public path it must call `reserveAttempt(sql, userId, 'mfa')`
 * before checking the code, or it becomes an unmetered guessing oracle.
 *
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
 * LONG-RUN CAP (MFA ONLY). The window counter alone resets, so someone holding
 * the password could still make ~4 TOTP guesses per 10 minutes for ever. `consecutive_failures`
 * is never reset by a window or a lock expiring: ONLY `recordSuccess` clears it.
 * Every reserved attempt that is not (yet) a success bumps it; at
 * `maxConsecutiveFailures` the account gets a long lock (24 h), and because the
 * count stays above the threshold, each later failed guess re-locks for 24 h.
 * This is the NIST SP 800-63B idea of a hard cap on consecutive failed
 * authenticators, with a time-based lock instead of permanent denial. A refused
 * (locked) attempt never changes anything, so a 24 h lock is not extended by
 * the attempts it refuses.
 *
 * The PASSWORD kind has NO long lock, on purpose. (1) Passwords are already
 * throttled to 10 per 15 minutes (~960 a day) and an account with 2FA is still
 * protected by the mfa step behind it. (2) A 24 h password lock would be a cheap
 * denial of service: anyone who knows a public handle could lock it with 100
 * requests and keep it locked with one a day. (3) Worse, a TOTP owner who
 * enters the correct password is told `mfa_required` and sends the code in a
 * second request; a long lock re-armed by that first request would trap them.
 * So login clears the password counter the moment the password verifies
 * (the mfa counter is separate and stays), and password locks are 15 minutes.
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
type Fragment = PendingQuery<Row[]>;

export type AttemptKind = 'password' | 'mfa';

export interface AttemptPolicy {
  /** Failures allowed inside one window. The attempt that reaches this number locks the account. */
  readonly maxFailures: number;
  /** A failure older than this no longer counts; the next one starts a new window. */
  readonly windowSeconds: number;
  /** How long the account refuses this kind of attempt once the window threshold locks it. Fixed (no escalation). */
  readonly lockSeconds: number;
  /**
   * Consecutive failures with no success in between, across any number of windows, before the long
   * lock. `null`: no long lock for this kind (see the PASSWORD note above).
   */
  readonly maxConsecutiveFailures: number | null;
  /** The long lock set at `maxConsecutiveFailures` (and again on every failed guess after it). */
  readonly longLockSeconds: number;
}

const DAY_SECONDS = 24 * 60 * 60;

/** The one place the numbers live. */
export const ATTEMPT_POLICY: Readonly<Record<AttemptKind, AttemptPolicy>> = {
  password: { maxFailures: 10, windowSeconds: 15 * 60, lockSeconds: 15 * 60, maxConsecutiveFailures: null, longLockSeconds: DAY_SECONDS },
  mfa: { maxFailures: 5, windowSeconds: 10 * 60, lockSeconds: 15 * 60, maxConsecutiveFailures: 20, longLockSeconds: DAY_SECONDS },
};

/** What a successful reservation tells the caller. */
export interface Reservation {
  /** Set only by the attempt that SET a lock (not by attempts a lock refuses): how long it locks for. */
  readonly lockedForSeconds: number | null;
}

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
 *  - `consecutive_failures` always + 1 (only `recordSuccess` resets it);
 *  - when it reaches `maxConsecutiveFailures`: long lock; else when `failures`
 *    reaches `maxFailures`: short lock. This attempt is still verified (it is the
 *    last permitted guess); the next is refused;
 *  - row currently locked: the WHERE clause makes the UPSERT a no-op, no row
 *    comes back, and we throw without touching anything.
 *
 * `now` defaults to the DATABASE clock, so replicas with skewed clocks agree;
 * tests inject it.
 */
export async function reserveAttempt(sql: Sql, userId: string, kind: AttemptKind, now?: Date): Promise<Reservation> {
  const { maxFailures, windowSeconds, lockSeconds, maxConsecutiveFailures, longLockSeconds } = ATTEMPT_POLICY[kind];
  const at = sql`COALESCE(${now ?? null}::timestamptz, now())`;
  const stale = sql`(a.locked_until <= ${at} OR a.window_started_at <= ${at} - make_interval(secs => ${windowSeconds}::int))`;
  const nextFailures = sql`(CASE WHEN ${stale} THEN 1 ELSE a.failures + 1 END)`;
  const lockFor = (failures: Fragment, consecutive: Fragment) => sql`
    CASE ${
      maxConsecutiveFailures === null
        ? sql``
        : sql`WHEN ${consecutive} >= ${maxConsecutiveFailures}::int THEN ${at} + make_interval(secs => ${longLockSeconds}::int)`
    }
         WHEN ${failures} >= ${maxFailures}::int THEN ${at} + make_interval(secs => ${lockSeconds}::int) END`;
  const reserved = await sql<Array<{ locked_seconds: number | null }>>`
    INSERT INTO auth_attempts AS a (user_id, kind, failures, consecutive_failures, window_started_at, locked_until, updated_at)
    VALUES (${userId}, ${kind}, 1, 1, ${at}, ${lockFor(sql`1`, sql`1`)}, ${at})
    ON CONFLICT (user_id, kind) DO UPDATE SET
      failures = ${nextFailures},
      consecutive_failures = a.consecutive_failures + 1,
      window_started_at = CASE WHEN ${stale} THEN ${at} ELSE a.window_started_at END,
      locked_until = ${lockFor(nextFailures, sql`(a.consecutive_failures + 1)`)},
      updated_at = ${at}
    WHERE a.locked_until IS NULL OR a.locked_until <= ${at}
    RETURNING CASE WHEN a.locked_until IS NULL THEN NULL
                   ELSE round(extract(epoch FROM (a.locked_until - ${at})))::int END AS locked_seconds`;
  if (reserved.length > 0) return { lockedForSeconds: reserved[0]!.locked_seconds ?? null };
  const rows = await sql<Array<{ retry: number | null }>>`
    SELECT GREATEST(1, ceil(extract(epoch FROM (locked_until - ${at}))))::int AS retry
    FROM auth_attempts WHERE user_id = ${userId} AND kind = ${kind}`;
  throw tooManyAttempts(rows[0]?.retry ?? lockSeconds);
}

/**
 * Read-only check: throws `auth.too_many_attempts` while locked, never changes state.
 * (`reserveAttempt` already includes this; it is for callers that must refuse
 * without counting.)
 */
export async function assertNotLocked(sql: Sql, userId: string, kind: AttemptKind, now?: Date): Promise<void> {
  const rows = await sql<Array<{ retry: number }>>`
    SELECT GREATEST(1, ceil(extract(epoch FROM (locked_until - COALESCE(${now ?? null}::timestamptz, now())))))::int AS retry
    FROM auth_attempts
    WHERE user_id = ${userId} AND kind = ${kind} AND locked_until > COALESCE(${now ?? null}::timestamptz, now())`;
  if (rows[0]) throw tooManyAttempts(rows[0].retry);
}

/**
 * Clear the counters for a user after the credential was verified. Because
 * `reserveAttempt` counts before verifying, this is what turns a reservation
 * into "not a failure".
 */
export async function recordSuccess(sql: Sql, userId: string, ...kinds: AttemptKind[]): Promise<void> {
  // Deleting the row resets BOTH the window counter and `consecutive_failures`.
  if (kinds.length === 0) return;
  await sql`DELETE FROM auth_attempts WHERE user_id = ${userId} AND kind IN ${sql(kinds)}`;
}
