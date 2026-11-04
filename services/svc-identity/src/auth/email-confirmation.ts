import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { transaction } from '@intafaced/db';
import type { Sql } from 'postgres';
import { AuthError } from './auth-service.js';
import { generateToken, hashToken } from './passwords.js';
import type { PasswordResetMail } from './password-reset.js';

/**
 * Signed-in email confirmation.
 *
 * `auth.requestEmailConfirmation` mails one high-entropy token (the link) and a six-digit code to the session user's
 * own address. The response is `{ accepted: true }` whether or not a message was handed to the mail port, so the call
 * is not an account-existence oracle. The token is stored only as a SHA-256 and the code only as an HMAC under the
 * flow key. `auth.confirmEmail` (the link) or `auth.confirmEmailCode` (the code, typed by the signed-in person) sets
 * `email_verified_at` for that user and that address, once; either one spends the proof.
 *
 * A second request before the owner's interval is refused with the seconds left (`auth.email_confirm_resend_too_soon`).
 * A link that ran out or was already used is refused by name (`auth.email_confirm_expired`, `auth.email_confirm_used`):
 * the token is 256 bits, so naming its state tells nothing to someone who does not hold it, and names no account.
 *
 * No mail transport refuses by the vendor's name (`vendor.email`). An unset lifetime, rate budget, interval, wrong-code
 * limit or flow key refuses every caller the same way (`auth.email_confirm_unwired`). Nothing here invents a number.
 */

/** One day. Longer than that is not a confirmation proof. */
const MAX_TTL_SECONDS = 86_400;
/** Technical ceiling for an owner-published budget. Not a default. */
const MAX_RATE = 1_000;
/** Technical ceilings for the owner's interval and wrong-code limit. Not defaults. */
const MAX_RESEND_SECONDS = 3_600;
const MAX_CODE_ATTEMPTS = 10;

const INVALID = 'That confirmation link is not valid. Request a new one.';
const EXPIRED = 'That confirmation link or code has run out. Send a new one.';
const USED = 'That confirmation link or code was already used.';
const DUMMY_HASH = hashToken('email-confirm-compare-dummy');

export interface EmailConfirmRate {
  readonly max: number;
  readonly windowSeconds: number;
}

export interface EmailConfirmDeps {
  readonly sql: Sql;
  readonly mail: PasswordResetMail | undefined;
  readonly ttlSeconds: number | undefined;
  readonly rateMax: number | undefined;
  readonly rateWindowSeconds: number | undefined;
  /** Seconds before another confirmation may be mailed to the same account. */
  readonly resendSeconds: number | undefined;
  /** Wrong codes allowed per mailed code; at the limit that code (and its link) is spent. */
  readonly codeMaxAttempts: number | undefined;
  /** HMAC key for the six-digit code: the flow key the sign-up and recovery codes use. */
  readonly subjectKey: string | undefined;
  readonly now: () => Date;
  readonly log: { warn(obj: Record<string, unknown>, msg: string): void };
}

export function publishedEmailConfirmTtlSeconds(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > MAX_TTL_SECONDS) return undefined;
  return value;
}

/** Both numbers must be published. Either one missing stays unpublished. */
export function publishedEmailConfirmRate(max: number | undefined, windowSeconds: number | undefined): EmailConfirmRate | undefined {
  if (max === undefined || windowSeconds === undefined) return undefined;
  if (!Number.isInteger(max) || max < 1 || max > MAX_RATE) return undefined;
  if (!Number.isInteger(windowSeconds) || windowSeconds < 1 || windowSeconds > MAX_TTL_SECONDS) return undefined;
  return { max, windowSeconds };
}

export function publishedEmailConfirmResendSeconds(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isInteger(value) || value < 1 || value > MAX_RESEND_SECONDS) return undefined;
  return value;
}

export function publishedEmailConfirmCodeAttempts(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isInteger(value) || value < 1 || value > MAX_CODE_ATTEMPTS) return undefined;
  return value;
}

/** The six-digit code's stored form: keyed, and bound to its proof's token hash, so equal codes never collide. */
function pinHash(subjectKey: string, tokenHash: string, pin: string): string {
  return createHmac('sha256', subjectKey).update(`email-confirm:${tokenHash}:${pin}`).digest('hex');
}

/** True only when `email_verified_at` is a real instant. Null and junk are not confirmed. */
export function isEmailConfirmed(row: { readonly email_verified_at?: Date | string | null }): boolean {
  const at = row.email_verified_at;
  if (at == null || at === '') return false;
  const parsed = at instanceof Date ? at : new Date(at);
  return !Number.isNaN(parsed.getTime());
}

export function normalizeConfirmEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** SHA-256 compare. A length mismatch still runs a compare so the branch is not a short cut. */
export function hashesEqual(storedHex: string, presentedHex: string): boolean {
  const left = Buffer.from(storedHex, 'hex');
  const right = Buffer.from(presentedHex, 'hex');
  const dummy = Buffer.from(DUMMY_HASH, 'hex');
  if (left.length !== right.length || left.length !== dummy.length) {
    timingSafeEqual(dummy, dummy);
    return false;
  }
  return timingSafeEqual(left, right);
}

type ProofRow = {
  id: string;
  user_id: string;
  code_hash: string;
  email_hash: string;
  consumed_at: Date | string | null;
  expires_at: Date | string;
};

type PinRow = ProofRow & { pin_hash: string | null; pin_attempts: number };

/**
 * Why a spent proof is spent, read from the account as it is now. Its address is no longer the account's: `mismatch`
 * (an email change spends open proofs). The address is the account's but unverified: the proof did not prove it, so
 * wrong codes spent it (`code_locked`). Otherwise it did its work: `reused`.
 */
async function spentReason(tx: Sql, proof: ProofRow): Promise<'mismatch' | 'code_locked' | 'reused'> {
  const owner = await tx<Array<{ email: string; email_verified_at: Date | string | null }>>`
    SELECT email::text AS email, email_verified_at FROM users WHERE id = ${proof.user_id}
  `;
  const account = owner[0];
  if (!account || !hashesEqual(proof.email_hash, hashToken(normalizeConfirmEmail(account.email)))) return 'mismatch';
  return isEmailConfirmed(account) ? 'reused' : 'code_locked';
}

function instant(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function unwired(deps: EmailConfirmDeps): 'mail' | 'ttl' | 'rate' | 'resend' | 'attempts' | 'key' | null {
  if (!deps.mail) return 'mail';
  if (publishedEmailConfirmTtlSeconds(deps.ttlSeconds) === undefined) return 'ttl';
  if (publishedEmailConfirmRate(deps.rateMax, deps.rateWindowSeconds) === undefined) return 'rate';
  if (publishedEmailConfirmResendSeconds(deps.resendSeconds) === undefined) return 'resend';
  if (publishedEmailConfirmCodeAttempts(deps.codeMaxAttempts) === undefined) return 'attempts';
  if (!deps.subjectKey) return 'key';
  return null;
}

/** No mail transport refuses by the vendor's name; any other blank refuses every caller the same way. */
function assertWired(deps: EmailConfirmDeps): void {
  const reason = unwired(deps);
  if (!reason) return;
  deps.log.warn({ reason }, 'auth.email_confirm_unwired');
  if (reason === 'mail') throw new AuthError('Email delivery is switched off, so no confirmation can be sent', 'vendor.email');
  throw new AuthError('Email confirmation is not available yet', 'auth.email_confirm_unwired');
}

export async function requestEmailConfirmation(deps: EmailConfirmDeps, input: { userId: string }): Promise<{ accepted: true }> {
  assertWired(deps);
  const mail = deps.mail!;
  const ttlSeconds = publishedEmailConfirmTtlSeconds(deps.ttlSeconds)!;
  const rate = publishedEmailConfirmRate(deps.rateMax, deps.rateWindowSeconds)!;
  const resendSeconds = publishedEmailConfirmResendSeconds(deps.resendSeconds)!;
  const subjectKey = deps.subjectKey!;
  const now = deps.now();
  const since = new Date(now.getTime() - rate.windowSeconds * 1000);

  const outcome = await transaction(
    deps.sql,
    async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('email-confirm'), hashtext(${input.userId}::text))`;
      const counted = await tx<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM email_confirmation_attempts
        WHERE user_id = ${input.userId} AND created_at > ${since}
      `;
      const n = Number(counted[0]?.n ?? 0);
      if (n >= rate.max) {
        // The wait is until enough requests leave the window for one more to fit: the (n - max + 1)th oldest.
        const freeing = await tx<Array<{ created_at: Date | string }>>`
          SELECT created_at FROM email_confirmation_attempts
          WHERE user_id = ${input.userId} AND created_at > ${since}
          ORDER BY created_at OFFSET ${n - rate.max} LIMIT 1
        `;
        const oldest = new Date(freeing[0]?.created_at ?? now).getTime();
        return {
          kind: 'rate' as const,
          retryAfterSeconds: Math.max(1, Math.ceil((oldest + rate.windowSeconds * 1000 - now.getTime()) / 1000)),
        };
      }
      // The owner's interval between two mails: the newest request decides. A refusal is not itself a request.
      const newest = await tx<Array<{ created_at: Date | string }>>`
        SELECT created_at FROM email_confirmation_attempts
        WHERE user_id = ${input.userId}
        ORDER BY created_at DESC LIMIT 1
      `;
      if (newest[0]) {
        const free = instant(newest[0].created_at) + resendSeconds * 1000;
        if (free > now.getTime()) {
          return { kind: 'soon' as const, retryAfterSeconds: Math.max(1, Math.ceil((free - now.getTime()) / 1000)) };
        }
      }

      const users = await tx<Array<{ id: string; status: string; email: string; email_verified_at: Date | string | null }>>`
        SELECT id, status, email::text AS email, email_verified_at
        FROM users WHERE id = ${input.userId} FOR UPDATE
      `;
      const user = users[0];
      if (!user) {
        hashToken(generateToken(32));
        return { kind: 'silent' as const };
      }
      await tx`INSERT INTO email_confirmation_attempts (user_id, created_at) VALUES (${user.id}, ${now})`;
      if (user.status !== 'active' || isEmailConfirmed(user)) {
        hashToken(generateToken(32));
        return { kind: 'silent' as const };
      }
      const code = generateToken(32);
      const tokenHash = hashToken(code);
      const pin = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
      await tx`
        INSERT INTO email_confirmation_proofs (user_id, code_hash, email_hash, expires_at, created_at, pin_hash)
        VALUES (${user.id}, ${tokenHash}, ${hashToken(normalizeConfirmEmail(user.email))}, ${expiresAt}, ${now},
                ${pinHash(subjectKey, tokenHash, pin)})
      `;
      await tx`
        INSERT INTO email_confirmation_audit (user_id, event, reason, created_at)
        VALUES (${user.id}, 'requested', 'issued', ${now})
      `;
      return { kind: 'send' as const, email: user.email, code, pin, expiresAt };
    },
    { isolation: 'read committed' },
  );

  if (outcome.kind === 'rate') {
    throw new AuthError('Too many confirmation emails. Try again later.', 'auth.email_confirm_rate_limited', {
      retryAfterSeconds: outcome.retryAfterSeconds,
    });
  }
  if (outcome.kind === 'soon') {
    throw new AuthError('A confirmation was sent a moment ago. Wait, then ask again.', 'auth.email_confirm_resend_too_soon', {
      retryAfterSeconds: outcome.retryAfterSeconds,
    });
  }
  if (outcome.kind === 'silent') return { accepted: true };

  try {
    await mail.send({ email: outcome.email, code: outcome.code, pin: outcome.pin, expiresAt: outcome.expiresAt, purpose: 'email-confirm' });
  } catch {
    deps.log.warn({ userId: input.userId }, 'auth.email_confirm_delivery_failed');
  }
  return { accepted: true };
}

export async function confirmEmail(deps: EmailConfirmDeps, input: { token: string }): Promise<{ userId: string }> {
  const token = input.token.trim();
  const presented = hashToken(token.length === 0 ? ' ' : token);
  const found = await deps.sql<ProofRow[]>`
    SELECT id, user_id, code_hash, email_hash, consumed_at, expires_at
    FROM email_confirmation_proofs
    WHERE code_hash = ${presented}
    LIMIT 1
  `;
  const row = found[0];
  if (!row || !hashesEqual(row.code_hash, presented)) {
    hashesEqual(DUMMY_HASH, presented);
    throw new AuthError(INVALID, 'auth.email_confirm_invalid');
  }

  const result = await transaction(
    deps.sql,
    async (tx) => {
      const locked = await tx<ProofRow[]>`
        SELECT id, user_id, code_hash, email_hash, consumed_at, expires_at
        FROM email_confirmation_proofs
        WHERE id = ${row.id}
        FOR UPDATE
      `;
      const proof = locked[0];
      if (!proof || !hashesEqual(proof.code_hash, presented)) {
        return { reason: 'unknown' as const, userId: null };
      }
      if (proof.consumed_at) {
        const spent = await spentReason(tx, proof);
        await tx`
          INSERT INTO email_confirmation_audit (user_id, event, reason, created_at)
          VALUES (${proof.user_id}, 'refused', ${spent}, ${deps.now()})
        `;
        return { reason: spent, userId: proof.user_id };
      }
      if (!(instant(proof.expires_at) > deps.now().getTime())) {
        await tx`
          INSERT INTO email_confirmation_audit (user_id, event, reason, created_at)
          VALUES (${proof.user_id}, 'refused', 'expired', ${deps.now()})
        `;
        return { reason: 'expired' as const, userId: proof.user_id };
      }
      const users = await tx<Array<{ id: string; status: string; email: string }>>`
        SELECT id, status, email::text AS email FROM users WHERE id = ${proof.user_id} FOR UPDATE
      `;
      const user = users[0];
      const emailOk = !!user && user.status === 'active' && hashesEqual(proof.email_hash, hashToken(normalizeConfirmEmail(user.email)));
      await tx`
        UPDATE email_confirmation_proofs
        SET consumed_at = ${deps.now()}
        WHERE id = ${proof.id} AND consumed_at IS NULL
      `;
      if (!emailOk || !user) {
        await tx`
          INSERT INTO email_confirmation_audit (user_id, event, reason, created_at)
          VALUES (${proof.user_id}, 'refused', 'mismatch', ${deps.now()})
        `;
        return { reason: 'mismatch' as const, userId: proof.user_id };
      }
      await tx`
        UPDATE users SET email_verified_at = ${deps.now()}, updated_at = now()
        WHERE id = ${user.id}
      `;
      await tx`
        INSERT INTO email_confirmation_audit (user_id, event, reason, created_at)
        VALUES (${user.id}, 'confirmed', 'confirmed', ${deps.now()})
      `;
      return { reason: 'confirmed' as const, userId: user.id };
    },
    { isolation: 'read committed' },
  );

  if (result.reason === 'expired') throw new AuthError(EXPIRED, 'auth.email_confirm_expired');
  // "Used" only when it did its work: the address it was for is the account's and is verified.
  if (result.reason === 'reused') throw new AuthError(USED, 'auth.email_confirm_used');
  if (result.reason !== 'confirmed' || !result.userId) {
    throw new AuthError(INVALID, 'auth.email_confirm_invalid');
  }
  return { userId: result.userId };
}

/**
 * The six-digit code from a confirmation mail, typed by the signed-in person on Account. Any live code of the account
 * counts (a slow first mail still works after a second was sent). Wrong codes are counted twice over: per mailed code,
 * where the owner's limit spends that mail (code and link), and per account across all mails inside the owner's rate
 * window, where the same limit holds every code until enough guesses leave the window. So a new mail never resets the
 * guessing budget. A code that ran out is refused by name; the mail's link keeps working while codes are held.
 */
export async function confirmEmailCode(deps: EmailConfirmDeps, input: { userId: string; code: string }): Promise<{ userId: string }> {
  assertWired(deps);
  const maxAttempts = publishedEmailConfirmCodeAttempts(deps.codeMaxAttempts)!;
  const rate = publishedEmailConfirmRate(deps.rateMax, deps.rateWindowSeconds)!;
  const subjectKey = deps.subjectKey!;
  const code = input.code.trim();
  const now = deps.now();
  const since = new Date(now.getTime() - rate.windowSeconds * 1000);

  type Outcome =
    { kind: 'confirmed' | 'already' | 'unknown' | 'expired' | 'used' | 'locked' | 'wrong' } | { kind: 'held'; retryAfterSeconds: number };
  const result = await transaction(
    deps.sql,
    async (tx): Promise<Outcome> => {
      const users = await tx<Array<{ id: string; status: string; email: string; email_verified_at: Date | string | null }>>`
        SELECT id, status, email::text AS email, email_verified_at FROM users WHERE id = ${input.userId} FOR UPDATE
      `;
      const user = users[0];
      if (!user || user.status !== 'active') return { kind: 'unknown' };
      if (isEmailConfirmed(user)) return { kind: 'already' };
      const proofs = await tx<PinRow[]>`
        SELECT id, user_id, code_hash, email_hash, consumed_at, expires_at, pin_hash, pin_attempts
        FROM email_confirmation_proofs
        WHERE user_id = ${user.id}
        ORDER BY created_at DESC, id DESC
        LIMIT 20
        FOR UPDATE
      `;
      const audit = (event: string, reason: string) => tx`
        INSERT INTO email_confirmation_audit (user_id, event, reason, created_at) VALUES (${user.id}, ${event}, ${reason}, ${now})
      `;
      const live = proofs.filter((p) => p.pin_hash && !p.consumed_at && instant(p.expires_at) > now.getTime());
      if (live.length === 0) {
        hashesEqual(DUMMY_HASH, pinHash(subjectKey, DUMMY_HASH, code));
        const newest = proofs[0];
        if (!newest?.pin_hash) return { kind: 'unknown' };
        if (newest.consumed_at) {
          // The account is unverified here, so a spent mail was spent by wrong codes or by an address change.
          const spent = await spentReason(tx, newest);
          await audit('refused', spent);
          return { kind: spent === 'code_locked' ? 'locked' : spent === 'reused' ? 'used' : 'unknown' };
        }
        await audit('refused', 'expired');
        return { kind: 'expired' };
      }

      // The account's guesses inside the window: at the limit every code is held, whichever mail it came from.
      const guessed = await tx<Array<{ created_at: Date | string }>>`
        SELECT created_at FROM email_confirmation_audit
        WHERE user_id = ${user.id} AND event = 'refused' AND reason = 'wrong_code' AND created_at > ${since}
        ORDER BY created_at
      `;
      if (guessed.length >= maxAttempts) {
        const freeing = instant(guessed[guessed.length - maxAttempts]!.created_at) + rate.windowSeconds * 1000;
        return { kind: 'held', retryAfterSeconds: Math.max(1, Math.ceil((freeing - now.getTime()) / 1000)) };
      }

      // Every live code is compared, so the time taken does not say which mail matched.
      let match: PinRow | undefined;
      for (const proof of live) {
        if (hashesEqual(proof.pin_hash!, pinHash(subjectKey, proof.code_hash, code)) && !match) match = proof;
      }
      if (!match) {
        const newest = live[0]!;
        const attempts = newest.pin_attempts + 1;
        const dead = attempts >= maxAttempts;
        // At the limit the newest mail is spent: neither its code nor its link confirms any more.
        await tx`
          UPDATE email_confirmation_proofs
          SET pin_attempts = ${attempts}, consumed_at = ${dead ? now : null}
          WHERE id = ${newest.id}
        `;
        await audit('refused', 'wrong_code');
        return { kind: dead ? 'locked' : 'wrong' };
      }
      await tx`UPDATE email_confirmation_proofs SET consumed_at = ${now} WHERE id = ${match.id} AND consumed_at IS NULL`;
      if (!hashesEqual(match.email_hash, hashToken(normalizeConfirmEmail(user.email)))) {
        await audit('refused', 'mismatch');
        return { kind: 'unknown' };
      }
      await tx`UPDATE users SET email_verified_at = ${now}, updated_at = now() WHERE id = ${user.id}`;
      await audit('confirmed', 'confirmed_code');
      return { kind: 'confirmed' };
    },
    { isolation: 'read committed' },
  );

  switch (result.kind) {
    case 'confirmed':
    case 'already':
      return { userId: input.userId };
    case 'expired':
      throw new AuthError(EXPIRED, 'auth.email_confirm_expired');
    case 'used':
      throw new AuthError(USED, 'auth.email_confirm_used');
    case 'locked':
      throw new AuthError('Too many wrong codes. Send a new code.', 'auth.email_confirm_code_locked');
    case 'held':
      throw new AuthError('Too many wrong codes. Use the link in the email, or try a code again later.', 'auth.email_confirm_code_locked', {
        retryAfterSeconds: result.retryAfterSeconds,
      });
    case 'wrong':
      throw new AuthError('That code is not right. Check the newest email.', 'auth.email_confirm_code_invalid');
    default:
      throw new AuthError('There is no live code for this account. Send a new one.', 'auth.email_confirm_code_invalid');
  }
}
