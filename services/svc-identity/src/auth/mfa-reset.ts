/**
 * The locked-out second-factor reset (I-signin-sessions-12 (c); J-identity-05 #2, #3). A person who lost the
 * authenticator app and every recovery code proves the password (the caller does that, on the sign-in lockout), then a
 * six-digit code mailed to the account's proved address, then waits the owner's IDENTITY_MFA_RESET_WAIT_SECONDS.
 *
 * - The wait starts when the code is confirmed. `completes_at` is fixed on the database clock (`clock_timestamp()`, after
 *   the row locks are held) and never moved: confirming again answers the time already set, and a later change to the
 *   owner's wait does not touch it. A blank wait refuses (`identity.mfa_reset_unconfigured`); it never means "no wait",
 *   and the sign-in page then points to Support.
 * - When the wait starts, every contact on file is told: the proved address by mail. A proved phone would be texted, but
 *   texting needs `vendor.sms`, which this build does not have, so the answer names that instead of claiming a text.
 * - Any signed-in session of the account stops it (`cancel`), which mails a notice too. So does a sign-in whose second step
 *   passes with the authenticator app or a recovery code (`stopByProof`): the person still has a way in.
 * - It is tied to the authenticator app it was started for: an app turned off or set up again after the wait began ends
 *   the reset (`expired`), never removes the new app.
 * - The customer security lock refuses a start and holds a waiting reset: nothing completes while the lock holds.
 * - Once the wait has passed, the next password sign-in completes it (`completeDue`): a compare-and-swap from `waiting`
 *   to `completed` at or after `completes_at` on the database clock, and in the same transaction the authenticator app
 *   and its recovery codes are removed and every session ends. A crash leaves either all of it or none of it.
 *
 * The code uses the owner's numbers for mailed sign-in codes (its lifetime and wrong tries). Codes are stored only as an
 * HMAC under the flow key; the plain code lives in the outbox row until the relay claims it, as every mailed code does.
 */
import { createHash, createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { transaction } from '@intafaced/db';
import type { Sql } from 'postgres';
import type { PasswordResetMail } from './password-reset.js';
import { maskEmail } from '../ops/account-directory.js';
import { assertNotSecurityLocked, securityLockHolds } from './security-lock.js';
import { queueFactorChangedNotice } from './factor-changed-notice.js';

/** One day. Longer than that is not a mailed code. */
const MAX_CODE_TTL_SECONDS = 86_400;
/** Thirty days: the longest wait this service will hold a reset open for. */
const MAX_WAIT_SECONDS = 30 * 24 * 3600;

export type MfaResetErrorCode =
  | 'identity.mfa_reset_unconfigured'
  | 'identity.mfa_reset_not_enrolled'
  | 'identity.mfa_reset_no_proved_address'
  | 'auth.codes_unwired'
  | 'auth.code_invalid'
  | 'auth.code_expired'
  | 'auth.too_many_attempts'
  | 'vendor.email';

export class MfaResetError extends Error {
  constructor(
    readonly code: MfaResetErrorCode,
    readonly details?: { readonly retryAfterSeconds?: number },
  ) {
    super(code);
    this.name = 'MfaResetError';
  }
}

/** Owner value in whole seconds. Blank or unset: undefined (refuse). Zero is a published "no wait". */
export function parseMfaResetWait(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  if (!/^\d+$/.test(raw.trim())) throw new Error('IDENTITY_MFA_RESET_WAIT_SECONDS must be whole seconds');
  const n = Number(raw.trim());
  if (n > MAX_WAIT_SECONDS) throw new Error('IDENTITY_MFA_RESET_WAIT_SECONDS is above 30 days');
  return n;
}

export interface MfaResetDeps {
  readonly sql: Sql;
  readonly mail: PasswordResetMail | undefined;
  /** IDENTITY_MFA_RESET_WAIT_SECONDS. Unset refuses. */
  readonly waitSeconds: number | undefined;
  /** The owner's mailed-code lifetime and wrong-try count (IDENTITY_LOGIN_CODE_*). Unset refuses. */
  readonly codeTtlSeconds: number | undefined;
  readonly maxAttempts: number | undefined;
  /** The flow HMAC key. Unset refuses. */
  readonly subjectKey: string | undefined;
  readonly now: () => Date;
  readonly log: { warn(obj: Record<string, unknown>, msg: string): void };
  readonly afterCommit?: (() => void | Promise<void>) | undefined;
}

/** What the person is shown. `email` is masked; `sms` names the missing rail when a proved phone could not be texted. */
export type MfaResetView =
  | { readonly state: 'code_sent'; readonly resetId: string; readonly email: string; readonly codeExpiresAt: string }
  | {
      readonly state: 'waiting';
      readonly resetId: string;
      readonly completesAt: string;
      readonly told: { readonly email: string; readonly sms: 'vendor.sms' | null };
    };

type Budget = { wait: number; ttl: number; maxAttempts: number; key: string; mail: PasswordResetMail };

function intIn(value: number | undefined, min: number, max: number): number | undefined {
  if (value === undefined || !Number.isInteger(value) || value < min || value > max) return undefined;
  return value;
}

/** The wait first: with it blank the page points to Support, whatever else is missing. */
function requireBudget(deps: MfaResetDeps): Budget {
  const wait = intIn(deps.waitSeconds, 0, MAX_WAIT_SECONDS);
  if (wait === undefined) throw new MfaResetError('identity.mfa_reset_unconfigured');
  const ttl = intIn(deps.codeTtlSeconds, 1, MAX_CODE_TTL_SECONDS);
  const maxAttempts = intIn(deps.maxAttempts, 1, 5);
  const key = deps.subjectKey && deps.subjectKey.length >= 32 ? deps.subjectKey : undefined;
  if (ttl === undefined || maxAttempts === undefined || key === undefined) {
    deps.log.warn(
      {
        missing: [ttl === undefined && 'code-ttl', maxAttempts === undefined && 'attempts', key === undefined && 'subject-key'].filter(
          Boolean,
        ),
      },
      'identity.mfa_reset_codes_unwired',
    );
    throw new MfaResetError('auth.codes_unwired');
  }
  if (!deps.mail) throw new MfaResetError('vendor.email');
  return { wait, ttl, maxAttempts, key, mail: deps.mail };
}

/** The wait alone, for a page that asks before the password is sent. */
export function mfaResetConfigured(deps: MfaResetDeps): boolean {
  return intIn(deps.waitSeconds, 0, MAX_WAIT_SECONDS) !== undefined;
}

function codeHash(key: string, resetId: string, code: string): string {
  return createHmac('sha256', key).update(`mfa-reset:${resetId}:${code}`).digest('hex');
}

type UserRow = {
  email: string | null;
  email_verified_at: Date | null;
  phone: string | null;
  phone_verified_at: Date | null;
  totp_secret: string | null;
  status: string;
};

async function lockUser(tx: Sql, userId: string): Promise<UserRow | undefined> {
  const [user] = await tx<UserRow[]>`
    SELECT email, email_verified_at, phone, phone_verified_at, totp_secret, status FROM users WHERE id = ${userId} FOR UPDATE`;
  return user;
}

/** One outbox row on the caller's transaction; the dedupe key makes a repeat a no-op. */
export async function queueMail(
  tx: Sql,
  input: { userId: string; key: string; purpose: string; recipient: string; code: string | null; expiresAt: Date; now: Date },
): Promise<void> {
  await tx`
    INSERT INTO mail_outbox (flow_id, user_id, dedupe_key, body_hash, purpose, recipient, code, expires_at, status, created_at)
    VALUES (
      NULL, ${input.userId}, ${input.key}, ${createHash('sha256').update(input.key).digest('hex')}, ${input.purpose},
      ${input.recipient}, ${input.code}, ${input.expiresAt}, 'pending', ${input.now}
    )
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`;
}

type ResetRow = {
  id: string;
  state: string;
  code_hash: string | null;
  code_expires_at: Date;
  attempts: number;
  completes_at: Date | null;
  expired: boolean;
};

function waitingView(row: { id: string; completes_at: Date | null }, user: UserRow): MfaResetView {
  return {
    state: 'waiting',
    resetId: row.id,
    completesAt: new Date(row.completes_at!).toISOString(),
    told: { email: maskEmail(user.email ?? ''), sms: user.phone && user.phone_verified_at ? 'vendor.sms' : null },
  };
}

async function settle<T>(deps: MfaResetDeps, work: Promise<T>): Promise<T> {
  const out = await work;
  await deps.afterCommit?.();
  return out;
}

/**
 * Step 1, for an account whose password the caller has just verified: mail a code to the proved address. A reset that
 * already waits answers as it stands (no new code, no new notice). A code still open is replaced, at most the owner's
 * wrong-try count of codes per code lifetime.
 */
export async function startMfaReset(deps: MfaResetDeps, userId: string): Promise<MfaResetView> {
  const budget = requireBudget(deps);
  return settle(
    deps,
    transaction(deps.sql, async (tx) => {
      const user = await lockUser(tx, userId);
      if (!user?.totp_secret) throw new MfaResetError('identity.mfa_reset_not_enrolled');
      await assertNotSecurityLocked(tx, userId);
      if (!user.email || !user.email_verified_at) throw new MfaResetError('identity.mfa_reset_no_proved_address');
      const [open] = await tx<ResetRow[]>`
        SELECT id, state, code_hash, code_expires_at, attempts, completes_at, false AS expired
        FROM mfa_resets WHERE user_id = ${userId} AND state IN ('code_sent', 'waiting')`;
      if (open?.state === 'waiting') return waitingView(open, user);
      const now = deps.now();
      const [recent] = await tx<Array<{ n: number; oldest: Date | null }>>`
        SELECT count(*)::int AS n, min(created_at) AS oldest FROM mfa_resets
        WHERE user_id = ${userId} AND created_at > ${new Date(now.getTime() - budget.ttl * 1000)}`;
      if (recent && recent.n >= budget.maxAttempts && recent.oldest) {
        const retryAfterSeconds = Math.max(1, Math.ceil((new Date(recent.oldest).getTime() + budget.ttl * 1000 - now.getTime()) / 1000));
        throw new MfaResetError('auth.too_many_attempts', { retryAfterSeconds });
      }
      if (open) await tx`UPDATE mfa_resets SET state = 'expired', code_hash = NULL, updated_at = ${now} WHERE id = ${open.id}`;
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const codeExpiresAt = new Date(now.getTime() + budget.ttl * 1000);
      const [row] = await tx<Array<{ id: string }>>`
        INSERT INTO mfa_resets (user_id, state, factor_enrolled_at, code_expires_at, created_at, updated_at)
        VALUES (
          ${userId}, 'code_sent', (SELECT totp_enrolled_at FROM users WHERE id = ${userId}), ${codeExpiresAt}, ${now}, ${now}
        ) RETURNING id`;
      const resetId = row!.id;
      await tx`UPDATE mfa_resets SET code_hash = ${codeHash(budget.key, resetId, code)} WHERE id = ${resetId}`;
      await queueMail(tx, {
        userId,
        key: `mfa-reset-code:${resetId}`,
        purpose: 'mfa-reset-code',
        recipient: user.email,
        code,
        expiresAt: codeExpiresAt,
        now,
      });
      return { state: 'code_sent' as const, resetId, email: maskEmail(user.email), codeExpiresAt: codeExpiresAt.toISOString() };
    }),
  );
}

/**
 * Step 2: the mailed code. A right one starts the wait and tells every contact; a wrong one counts, and the owner's
 * count locks this reset. Confirming a reset that already waits answers its time, unchanged.
 */
export async function confirmMfaReset(deps: MfaResetDeps, input: { resetId: string; code: string }): Promise<MfaResetView> {
  const budget = requireBudget(deps);
  const outcome = await transaction(deps.sql, async (tx) => {
    // The user row first, then the reset, in the same order as start, cancel and completion.
    const [owner] = await tx<Array<{ user_id: string }>>`SELECT user_id FROM mfa_resets WHERE id = ${input.resetId}`;
    if (!owner) return { refuse: 'auth.code_invalid' as const };
    const user = await lockUser(tx, owner.user_id);
    if (!user) return { refuse: 'auth.code_invalid' as const };
    const [row] = await tx<Array<ResetRow & { user_id: string }>>`
      SELECT id, user_id, state, code_hash, code_expires_at, attempts, completes_at, code_expires_at <= clock_timestamp() AS expired
      FROM mfa_resets WHERE id = ${input.resetId} FOR UPDATE`;
    if (!row) return { refuse: 'auth.code_invalid' as const };
    if (row.state === 'locked') return { refuse: 'auth.too_many_attempts' as const };
    if (row.state !== 'code_sent' && row.state !== 'waiting') return { refuse: 'auth.code_expired' as const };
    if (row.state === 'waiting') return { view: waitingView(row, user) };
    if (row.expired) {
      await tx`UPDATE mfa_resets SET state = 'expired', code_hash = NULL, updated_at = now() WHERE id = ${row.id}`;
      return { refuse: 'auth.code_expired' as const };
    }
    const given = Buffer.from(codeHash(budget.key, row.id, input.code.replace(/\D/g, '')), 'hex');
    const stored = Buffer.from(row.code_hash ?? '', 'hex');
    if (stored.length !== given.length || !timingSafeEqual(stored, given)) {
      const attempts = row.attempts + 1;
      const lock = attempts >= budget.maxAttempts;
      await tx`UPDATE mfa_resets SET attempts = ${attempts}, state = ${lock ? 'locked' : 'code_sent'},
        code_hash = ${lock ? null : row.code_hash}, updated_at = now() WHERE id = ${row.id}`;
      return { refuse: lock ? ('auth.too_many_attempts' as const) : ('auth.code_invalid' as const) };
    }
    // Still the account it was started for: an authenticator to remove, a proved address to tell, an active account.
    const [tied] = await tx<Array<{ same: boolean }>>`
      SELECT r.factor_enrolled_at IS NOT DISTINCT FROM u.totp_enrolled_at AS same
      FROM mfa_resets r JOIN users u ON u.id = r.user_id WHERE r.id = ${row.id}`;
    if (!user.totp_secret || !tied?.same || user.status !== 'active' || !user.email || !user.email_verified_at) {
      await tx`UPDATE mfa_resets SET state = 'expired', code_hash = NULL, updated_at = now() WHERE id = ${row.id}`;
      return { refuse: 'auth.code_expired' as const };
    }
    const [waiting] = await tx<Array<{ id: string; completes_at: Date }>>`
      UPDATE mfa_resets SET state = 'waiting', code_hash = NULL, wait_seconds = ${budget.wait},
        waiting_since = clock_timestamp(), completes_at = clock_timestamp() + make_interval(secs => ${budget.wait}),
        updated_at = clock_timestamp()
      WHERE id = ${row.id} AND state = 'code_sent'
      RETURNING id, completes_at`;
    await queueMail(tx, {
      userId: row.user_id,
      key: `mfa-reset-started:${row.id}`,
      purpose: 'mfa-reset-started',
      recipient: user.email,
      code: null,
      expiresAt: waiting!.completes_at,
      now: deps.now(),
    });
    return { view: waitingView(waiting!, user) };
  });
  await deps.afterCommit?.();
  if ('refuse' in outcome) throw new MfaResetError(outcome.refuse!);
  return outcome.view;
}

/** The account's waiting reset, for its own signed-in sessions. Null when none waits. */
export async function mfaResetStatus(
  sql: Sql,
  userId: string,
): Promise<{ resetId: string; waitingSince: string; completesAt: string } | null> {
  const [row] = await sql<Array<{ id: string; waiting_since: Date; completes_at: Date }>>`
    SELECT r.id, r.waiting_since, r.completes_at FROM mfa_resets r JOIN users u ON u.id = r.user_id
    WHERE r.user_id = ${userId} AND r.state = 'waiting'
      AND u.totp_secret IS NOT NULL AND u.totp_enrolled_at IS NOT DISTINCT FROM r.factor_enrolled_at`;
  if (!row) return null;
  return {
    resetId: row.id,
    waitingSince: new Date(row.waiting_since).toISOString(),
    completesAt: new Date(row.completes_at).toISOString(),
  };
}

/**
 * Stop the account's open reset from one of its own sessions. Answers whether one was stopped; stopping nothing is not an
 * error. A reset that was waiting mails a notice to the proved address.
 */
export async function cancelMfaReset(
  deps: MfaResetDeps,
  input: { userId: string; sessionId: string | null },
): Promise<{ cancelled: boolean }> {
  const out = await transaction(deps.sql, async (tx) => {
    const user = await lockUser(tx, input.userId);
    const rows = await tx<Array<{ id: string; was: string }>>`
      UPDATE mfa_resets AS r SET state = 'cancelled', code_hash = NULL, cancelled_at = clock_timestamp(),
        cancelled_by_session = ${input.sessionId}, updated_at = clock_timestamp()
      FROM (SELECT id, state AS was FROM mfa_resets WHERE user_id = ${input.userId} AND state IN ('code_sent', 'waiting') FOR UPDATE) AS o
      WHERE r.id = o.id
      RETURNING r.id, o.was`;
    const stopped = rows.find((r) => r.was === 'waiting');
    if (stopped && user?.email && user.email_verified_at) {
      const now = deps.now();
      await queueMail(tx, {
        userId: input.userId,
        key: `mfa-reset-cancelled:${stopped.id}`,
        purpose: 'mfa-reset-cancelled',
        recipient: user.email,
        code: null,
        expiresAt: now,
        now,
      });
    }
    return { cancelled: rows.length > 0 };
  });
  await deps.afterCommit?.();
  return out;
}

/**
 * A sign-in whose second step passed with the authenticator app or a recovery code: the person still has a way in, so
 * the account's open reset stops (with its notice, as a cancel). A read first, so a sign-in with nothing open takes no
 * row lock.
 */
export async function stopMfaResetByProof(deps: MfaResetDeps, userId: string): Promise<boolean> {
  const [open] = await deps.sql<Array<{ id: string }>>`
    SELECT id FROM mfa_resets WHERE user_id = ${userId} AND state IN ('code_sent', 'waiting')`;
  if (!open) return false;
  return (await cancelMfaReset(deps, { userId, sessionId: null })).cancelled;
}

/**
 * At a password sign-in: complete the account's reset if its wait has passed, in one transaction with the removal of the
 * authenticator app and its recovery codes and the end of every session. Answers whether it completed. Called only after
 * the password verified and the account is active.
 */
export async function completeDueMfaReset(deps: MfaResetDeps, userId: string): Promise<boolean> {
  // A read first, so a sign-in with nothing waiting takes no row lock. The transaction below is the authority.
  const [due] = await deps.sql<Array<{ id: string }>>`
    SELECT id FROM mfa_resets WHERE user_id = ${userId} AND state = 'waiting' AND completes_at <= clock_timestamp()`;
  if (!due) return false;
  const done = await transaction(deps.sql, async (tx) => {
    const user = await lockUser(tx, userId);
    if (!user || user.status !== 'active') return false;
    // The lock holds the reset: it stays waiting and completes at the first sign-in after the lock ends.
    if (await securityLockHolds(tx, userId)) return false;
    const [row] = await tx<Array<{ id: string; same_factor: boolean }>>`
      SELECT r.id, r.factor_enrolled_at IS NOT DISTINCT FROM u.totp_enrolled_at AS same_factor
      FROM mfa_resets r JOIN users u ON u.id = r.user_id
      WHERE r.user_id = ${userId} AND r.state = 'waiting' AND r.completes_at <= clock_timestamp() FOR UPDATE OF r`;
    if (!row) return false;
    // Only the app it was started for: one turned off or set up again since then ends the reset and stays.
    if (!user.totp_secret || !row.same_factor) {
      await tx`UPDATE mfa_resets SET state = 'expired', updated_at = clock_timestamp() WHERE id = ${row.id}`;
      return false;
    }
    await tx`UPDATE mfa_resets SET state = 'completed', completed_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE id = ${row.id}`;
    await tx`UPDATE users SET totp_secret = NULL, totp_label = NULL, totp_enrolled_at = NULL, totp_last_step = NULL,
      recovery_code_hashes = '[]'::jsonb, updated_at = now() WHERE id = ${userId}`;
    await tx`UPDATE sessions SET revoked = true WHERE user_id = ${userId} AND revoked = false`;
    // The inbox hears the app went (I-signin-sessions-08); the mail is the mfa-reset-completed notice below.
    await queueFactorChangedNotice(tx, { userId, change: 'totp_removed', now: deps.now(), mail: false });
    if (user.email && user.email_verified_at) {
      const now = deps.now();
      await queueMail(tx, {
        userId,
        key: `mfa-reset-completed:${row.id}`,
        purpose: 'mfa-reset-completed',
        recipient: user.email,
        code: null,
        expiresAt: now,
        now,
      });
    }
    return true;
  });
  if (done) await deps.afterCommit?.();
  return done;
}
