import { createHmac } from 'node:crypto';
import { transaction } from '@intafaced/db';
import type { Sql } from 'postgres';
import { AuthError } from './auth-service.js';
import { queuePasswordChangedNotice } from './password-changed-notice.js';
import { assertNotSecurityLocked } from './security-lock.js';
import {
  assertPasswordNotBreached,
  assertPasswordShape,
  assertPasswordNotIdentity,
  dummyPasswordHash,
  generateToken,
  hashPassword,
  hashToken,
  verifyPassword,
  WeakPasswordError,
} from './passwords.js';

/**
 * Signed-out password reset (D-38, S13).
 *
 * ACC-0017: asking for a reset creates a one-time proof and does not change the
 * password hash or mint a session.
 * ACC-0064: a wrong, expired, or unknown-email proof leaves the hash unchanged,
 * so the old password still signs in.
 * ACC-0172: a correct proof replaces the hash and ends the old sessions. The
 * call does not mint a session. The same proof, and any other proof still open
 * for that account, cannot rotate the hash again.
 *
 * The code is high-entropy and only the SHA-256 is stored on the flow. It is handed to the
 * mail relay and must not be logged. There is no git-default number: an unset lifetime,
 * attempt cap, request cap or window, or identifier key refuses every address the same way
 * (`auth.reset_unwired`). A missing mail transport does not refuse: the job is marked
 * `undeliverable` and the request still answers `accepted`.
 *
 * Equal work (FLW-3). Every request that is under the cap, for a known address or not, locks the
 * same identifier, counts the same rows, inserts one `auth_flows` row and one `mail_outbox` row.
 * The mail goes out later, from the relay, so the response does not show whether an account exists.
 */

/** One day. Longer than that is not a reset proof. */
const MAX_TTL_SECONDS = 86_400;

export interface PasswordResetMail {
  /**
   * Hand the one-time code to this address. Throw if the handoff failed.
   * `code` is a secret: do not log it, and do not put it in an error message.
   * Email confirmation uses the same port with `purpose: 'email-confirm'`.
   */
  send(message: {
    readonly email: string;
    readonly code: string;
    readonly expiresAt: Date;
    readonly purpose?: MailPurpose;
    /** The username, for the recovery mail only. */
    readonly handle?: string;
    /** The account the mail is about, when the sender knows it and the address may no longer name it. */
    readonly userId?: string;
    /** The account's anti-phishing code, on mails to its own address when its owner set one. */
    readonly antiPhishingCode?: string;
    /** A plain line naming what a service mail is about (`POST /internal/mail`), for example the address to approve. */
    readonly detail?: string;
    /** The one-time freeze link's token, on security notices only (`freeze-link.ts`). A secret, like `code`. */
    readonly freezeToken?: string;
  }): Promise<void>;
}

/** What a mail is for. The recovery and sign-up notices carry no code; their `code` is empty. */
export type MailPurpose =
  | 'password-reset'
  | 'email-confirm'
  | 'email-change'
  | 'email-change-notice'
  | 'reset-no-account'
  | 'handle-recovery'
  | 'handle-recovery-no-account'
  | 'signup-code'
  | 'signup-existing'
  | 'login-code'
  | 'login-no-account'
  | 'new-device-code'
  | 'withdraw-address-approval'
  | 'password-changed'
  | 'mfa-reset-code'
  | 'mfa-reset-started'
  | 'mfa-reset-cancelled'
  | 'mfa-reset-completed'
  | 'factor-changed'
  | 'support-recovery'
  | 'support-recovery-used';

export interface PasswordResetDeps {
  readonly sql: Sql;
  readonly mail: PasswordResetMail | undefined;
  readonly ttlSeconds: number | undefined;
  /** Wrong codes allowed per flow. Owner-published; unset refuses. */
  readonly maxAttempts?: number | undefined;
  /** Requests per address inside the window. Owner-published; unset refuses. */
  readonly requestMax?: number | undefined;
  readonly requestWindowSeconds?: number | undefined;
  /** HMAC key for the address identifier. Owner-published; unset refuses. */
  readonly subjectKey?: string | undefined;
  /** Mail an address with no account a notice. Off unless the owner turns it on. */
  readonly notifyUnknown?: boolean | undefined;
  readonly now: () => Date;
  readonly log: { warn(obj: Record<string, unknown>, msg: string): void };
  /** Called after a request commits, to start the mail relay off the response path. */
  readonly afterCommit?: (() => void | Promise<void>) | undefined;
}

/**
 * An owner-published lifetime in seconds, or undefined when nothing is published.
 * 0, fractions, and values above one day are unpublished. This does not fill in 900.
 */
export function publishedPasswordResetTtlSeconds(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > MAX_TTL_SECONDS) return undefined;
  return value;
}

const INVALID_PROOF = 'That reset code is not valid. Request a new one.';
const LOCKED = 'Too many wrong codes. Try again later.';
const UNWIRED = 'Password reset is not available yet';

function normalizeEmail(email: string): string {
  return email.trim();
}

/** Same cost and same error for every failed proof, so the answer does not say whether the email exists. */
async function rejectInvalidProof(newPassword: string): Promise<never> {
  await verifyPassword(await dummyPasswordHash(), newPassword);
  throw new AuthError(INVALID_PROOF, 'auth.reset_proof_invalid');
}

type Budget = {
  readonly ttlSeconds: number;
  readonly maxAttempts: number;
  readonly requestMax: number;
  readonly requestWindowSeconds: number;
  readonly subjectKey: string;
};

function intIn(value: number | undefined, max: number): number | undefined {
  if (value === undefined || !Number.isInteger(value) || value < 1 || value > max) return undefined;
  return value;
}

/** Every owner-published number and the key, or the one refusal. Which one is missing goes to the log only. */
function requireBudget(deps: PasswordResetDeps): Budget {
  const ttlSeconds = publishedPasswordResetTtlSeconds(deps.ttlSeconds);
  const maxAttempts = intIn(deps.maxAttempts, 5);
  const requestMax = intIn(deps.requestMax, 1_000);
  const requestWindowSeconds = intIn(deps.requestWindowSeconds, MAX_TTL_SECONDS);
  const subjectKey = deps.subjectKey && deps.subjectKey.length >= 32 ? deps.subjectKey : undefined;
  const missing = [
    ttlSeconds === undefined && 'ttl',
    maxAttempts === undefined && 'attempts',
    requestMax === undefined && 'request-max',
    requestWindowSeconds === undefined && 'request-window',
    subjectKey === undefined && 'subject-key',
  ].filter(Boolean);
  if (missing.length > 0) {
    deps.log.warn({ missing }, 'auth.password_reset_unwired');
    throw new AuthError(UNWIRED, 'auth.reset_unwired');
  }
  return {
    ttlSeconds: ttlSeconds!,
    maxAttempts: maxAttempts!,
    requestMax: requestMax!,
    requestWindowSeconds: requestWindowSeconds!,
    subjectKey: subjectKey!,
  };
}

/** The identifier a flow is counted by: an HMAC of the lower-cased address. The address is not stored on the flow. */
export function flowSubjectHash(subjectKey: string, email: string): string {
  return createHmac('sha256', subjectKey).update(normalizeEmail(email).toLowerCase()).digest('hex');
}

type FlowKind = 'password_reset' | 'handle_recovery';

/**
 * One recovery request. Known and active address: a flow that carries a code (password reset) or the
 * handle (recovery). Anything else: a `suppressed` flow and, only when the owner turned notices on, a
 * "no account" mail. Either way the same statements run. Over the cap nothing is written for either.
 */
async function openFlow(deps: PasswordResetDeps, kind: FlowKind, email: string): Promise<void> {
  const budget = requireBudget(deps);
  const address = normalizeEmail(email);
  const subjectHash = flowSubjectHash(budget.subjectKey, address);
  const users = await deps.sql<Array<{ id: string; status: string; email: string; handle: string }>>`
    SELECT id, status, email, handle FROM users WHERE email = ${address}
  `;
  const user = users[0] && users[0].status === 'active' ? users[0] : undefined;
  const now = deps.now();
  const code = generateToken(32);
  const codeHash = hashToken(code);
  const expiresAt = new Date(now.getTime() + budget.ttlSeconds * 1000);
  const since = new Date(now.getTime() - budget.requestWindowSeconds * 1000);
  const known = kind === 'password_reset' ? 'password-reset' : 'handle-recovery';
  const unknown = kind === 'password_reset' ? 'reset-no-account' : 'handle-recovery-no-account';

  const written = await transaction(
    deps.sql,
    async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${subjectHash}))`;
      const recent = await tx<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM auth_flows
        WHERE subject_hash = ${subjectHash} AND kind = ${kind} AND created_at > ${since}
      `;
      if ((recent[0]?.n ?? 0) >= budget.requestMax) return false;
      const flow = await tx<Array<{ id: string }>>`
        INSERT INTO auth_flows (kind, subject_hash, user_id, code_hash, status, expires_at, created_at)
        VALUES (
          ${kind}, ${subjectHash}, ${user?.id ?? null}, ${codeHash}, ${user ? 'code_sent' : 'suppressed'}, ${expiresAt}, ${now}
        )
        RETURNING id
      `;
      const sendable = user !== undefined || deps.notifyUnknown === true;
      await tx`
        INSERT INTO mail_outbox (flow_id, purpose, recipient, code, handle, expires_at, status)
        VALUES (
          ${flow[0]!.id}, ${user ? known : unknown}, ${user ? user.email : address},
          ${user && kind === 'password_reset' ? code : null}, ${user && kind === 'handle_recovery' ? user.handle : null},
          ${expiresAt}, ${sendable ? 'pending' : 'suppressed'}
        )
      `;
      return sendable;
    },
    { isolation: 'read committed' },
  );
  if (written) await deps.afterCommit?.();
}

export async function requestPasswordReset(deps: PasswordResetDeps, input: { email: string }): Promise<{ accepted: true }> {
  await openFlow(deps, 'password_reset', input.email);
  return { accepted: true };
}

/** Same shape as the reset request: mail the username to a known address, a notice (if on) otherwise. */
export async function requestHandleRecovery(deps: PasswordResetDeps, input: { email: string }): Promise<{ accepted: true }> {
  await openFlow(deps, 'handle_recovery', input.email);
  return { accepted: true };
}

/**
 * Retries of a security notice (password changed, second-step reset) whose send threw: the first waits
 * `MAIL_RETRY_FIRST_WAIT_MS`, each next one twice as long, and after `MAIL_RETRY_CAP` failed sends (about two hours from
 * the first) the row stays `unknown` like any other failed mail and the relay logs that it gave up. An engineering bound on retrying an outage, not an owner setting or a live
 * magnitude: it decides only how long a free notice is retried.
 */
export const MAIL_RETRY_CAP = 8;
export const MAIL_RETRY_FIRST_WAIT_MS = 60_000;

/**
 * Notices that tell the person something already happened to the account's security: never withdrawn by a later freeze
 * or address change, and sent again when a send threw. Their only secret is the freeze link (`freeze-link.ts`), minted
 * afresh at each attempt and good once, so a second copy harms nothing.
 */
const SECURITY_NOTICES = new Set([
  'password-changed',
  'mfa-reset-started',
  'mfa-reset-cancelled',
  'mfa-reset-completed',
  'factor-changed',
  'support-recovery-used',
]);

/**
 * Send the pending jobs that are due. A row is claimed (its secret cleared) before the send, so a crash or
 * a lost reply leaves `unknown` and the flow still valid (T-10), never a second mail. A security notice whose send
 * threw is the one row sent again, on the wait above. With no mail transport the rows are marked `undeliverable`
 * for the founder delivery desk.
 */
export async function relayMailOutbox(
  deps: PasswordResetDeps,
  limit = 25,
): Promise<{ sent: number; undeliverable: number; unknown: number }> {
  const claimed = await deps.sql<
    Array<{
      id: string;
      purpose: string;
      recipient: string;
      code: string | null;
      handle: string | null;
      expires_at: Date;
      user_id: string | null;
      detail: string | null;
    }>
  >`
    WITH due AS (
      SELECT id, code, handle FROM mail_outbox
      WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ${deps.now()})
      ORDER BY created_at LIMIT ${limit} FOR UPDATE SKIP LOCKED
    )
    UPDATE mail_outbox AS m
    SET status = ${deps.mail ? 'unknown' : 'undeliverable'}, code = NULL, handle = NULL
    FROM due
    WHERE m.id = due.id
    RETURNING m.id, m.purpose, m.recipient, due.code, due.handle, m.expires_at, m.user_id, m.detail
  `;
  const out = { sent: 0, undeliverable: 0, unknown: 0 };
  const mail = deps.mail;
  if (!mail) {
    out.undeliverable = claimed.length;
    return out;
  }
  for (const job of claimed) {
    // A service mail (POST /internal/mail) goes out only while its account is still active and the address is still
    // its proved one; a freeze or an address change between the request and the send withdraws it. The password-changed
    // notice and the second-step reset notices are not withdrawn: they go to the address proved at the change, which is
    // the point of them.
    if (job.user_id && !SECURITY_NOTICES.has(job.purpose) && !(await stillOwnAddress(deps.sql, job.user_id, job.recipient))) {
      await deps.sql`UPDATE mail_outbox SET status = 'suppressed' WHERE id = ${job.id}`;
      continue;
    }
    try {
      await mail.send({
        email: job.recipient,
        code: job.code ?? '',
        expiresAt: job.expires_at instanceof Date ? job.expires_at : new Date(job.expires_at),
        purpose: job.purpose as MailPurpose,
        ...(job.handle ? { handle: job.handle } : {}),
        ...(job.user_id ? { userId: job.user_id } : {}),
        ...(job.detail ? { detail: job.detail } : {}),
      });
      await deps.sql`UPDATE mail_outbox SET status = 'sent', sent_at = ${deps.now()} WHERE id = ${job.id}`;
      out.sent += 1;
    } catch {
      // A throw can follow a send that landed. The row stays `unknown`, the flow stays valid. A security notice carries
      // no secret, so a second copy harms nothing: it goes back to pending and waits its turn, until the cap.
      deps.log.warn({ jobId: job.id, purpose: job.purpose }, 'auth.password_reset_delivery_failed');
      if (SECURITY_NOTICES.has(job.purpose)) await retryNotice(deps, job.id);
      out.unknown += 1;
    }
  }
  return out;
}

/** One statement, so a crash cannot count a failed send without putting the notice back for its next try. */
async function retryNotice(deps: PasswordResetDeps, id: string): Promise<void> {
  const [row] = await deps.sql<Array<{ failed_sends: number }>>`
    UPDATE mail_outbox
    SET failed_sends = failed_sends + 1,
      status = CASE WHEN failed_sends + 1 < ${MAIL_RETRY_CAP} THEN 'pending' ELSE status END,
      next_attempt_at = CASE WHEN failed_sends + 1 < ${MAIL_RETRY_CAP}
        THEN ${deps.now()}::timestamptz + make_interval(secs => ${MAIL_RETRY_FIRST_WAIT_MS / 1000} * power(2, failed_sends))
        ELSE next_attempt_at END
    WHERE id = ${id}
    RETURNING failed_sends
  `;
  const failed = row?.failed_sends ?? MAIL_RETRY_CAP;
  if (failed >= MAIL_RETRY_CAP) deps.log.warn({ jobId: id, failedSends: failed }, 'auth.password_changed_notice_abandoned');
}

async function stillOwnAddress(sql: Sql, userId: string, recipient: string): Promise<boolean> {
  const [user] = await sql<Array<{ status: string; email: string | null; email_verified_at: Date | null }>>`
    SELECT status, email, email_verified_at FROM users WHERE id = ${userId}
  `;
  return user?.status === 'active' && user.email === recipient && user.email_verified_at !== null;
}

type OpenFlow = { id: string; user_id: string | null; code_hash: string; status: string; attempts: number; expires_at: Date };

export async function completePasswordReset(
  deps: PasswordResetDeps,
  input: { email: string; code: string; newPassword: string },
): Promise<{ userId: string; sessionsRevoked: number }> {
  const budget = requireBudget(deps);
  const email = normalizeEmail(input.email);
  const code = input.code.trim();
  const codeHash = hashToken(code);
  const now = deps.now();
  const subjectHash = flowSubjectHash(budget.subjectKey, email);
  const open = await deps.sql<OpenFlow[]>`
    SELECT id, user_id, code_hash, status, attempts, expires_at FROM auth_flows
    WHERE subject_hash = ${subjectHash} AND kind = 'password_reset' AND consumed_at IS NULL AND expires_at > ${now}
    ORDER BY created_at DESC
  `;
  const newest = open[0];
  if (!newest || code.length === 0) return rejectInvalidProof(input.newPassword);
  const lockedFor = () => Math.max(1, Math.ceil((new Date(newest.expires_at).getTime() - now.getTime()) / 1000));
  if (newest.status === 'locked' || newest.attempts >= budget.maxAttempts) {
    throw new AuthError(LOCKED, 'auth.too_many_attempts', { retryAfterSeconds: lockedFor() });
  }

  const flow = open.find((row) => row.status === 'code_sent' && row.user_id !== null && row.code_hash === codeHash);
  if (!flow) {
    // A wrong code counts the same for an address with an account and one without.
    const counted = await deps.sql<Array<{ attempts: number }>>`
      UPDATE auth_flows
      SET attempts = attempts + 1, status = CASE WHEN attempts + 1 >= ${budget.maxAttempts} THEN 'locked' ELSE status END
      WHERE id = ${newest.id}
      RETURNING attempts
    `;
    if ((counted[0]?.attempts ?? 0) >= budget.maxAttempts) {
      throw new AuthError(LOCKED, 'auth.too_many_attempts', { retryAfterSeconds: lockedFor() });
    }
    return rejectInvalidProof(input.newPassword);
  }

  const users = await deps.sql<Array<{ id: string; password_hash: string; status: string; handle: string; email: string }>>`
    SELECT id, password_hash, status, handle, email FROM users WHERE id = ${flow.user_id}
  `;
  const user = users[0];
  if (!user || user.status !== 'active') return rejectInvalidProof(input.newPassword);

  try {
    assertPasswordShape(input.newPassword);
    assertPasswordNotIdentity(input.newPassword, user);
    assertPasswordNotBreached(input.newPassword);
  } catch (err) {
    if (err instanceof WeakPasswordError) throw new AuthError(err.message, err.code);
    throw err;
  }
  if (await verifyPassword(user.password_hash, input.newPassword)) {
    throw new AuthError('The new password must differ from the current one', 'auth.password_unchanged');
  }
  const nextHash = await hashPassword(input.newPassword);

  const { revokedIds, noticed } = await transaction(
    deps.sql,
    async (tx) => {
      const locked = await tx<Array<{ status: string }>>`
        SELECT status FROM users WHERE id = ${user.id} FOR UPDATE
      `;
      if (!locked[0] || locked[0].status !== 'active') {
        throw new AuthError(INVALID_PROOF, 'auth.reset_proof_invalid');
      }
      // The owner's security lock (W-withdraw-09) stops a reset too, after the code proved the address: the code stays
      // unspent, and the person sees why. Under the user row lock, so a lock set meanwhile is seen.
      await assertNotSecurityLocked(tx, user.id);
      const proof = await tx<Array<{ id: string }>>`
        SELECT id FROM auth_flows
        WHERE id = ${flow.id} AND status = 'code_sent' AND consumed_at IS NULL AND expires_at > ${deps.now()}
        FOR UPDATE
      `;
      if (!proof[0]) throw new AuthError(INVALID_PROOF, 'auth.reset_proof_invalid');
      // A reset gives back a password the owner stopped using (I-account-lifecycle-07): the mailed code proved the address.
      await tx`UPDATE users SET password_hash = ${nextHash}, password_set = true, updated_at = now() WHERE id = ${user.id}`;
      await tx`
        UPDATE auth_flows SET status = 'consumed', consumed_at = ${deps.now()}
        WHERE user_id = ${user.id} AND kind = 'password_reset' AND consumed_at IS NULL
      `;
      const revoked = await tx<Array<{ id: string }>>`
        UPDATE sessions SET revoked = true
        WHERE user_id = ${user.id} AND revoked = false
        RETURNING id
      `;
      const noticed = await queuePasswordChangedNotice(tx, { userId: user.id, now: deps.now() });
      return { revokedIds: revoked.map((row) => row.id), noticed };
    },
    { isolation: 'read committed' },
  );
  // The reset has committed: a relay that fails to start now must not make it look refused. The timer relay sends it.
  if (noticed) await Promise.resolve(deps.afterCommit?.()).catch(() => undefined);

  return { userId: user.id, sessionsRevoked: revokedIds.length };
}
