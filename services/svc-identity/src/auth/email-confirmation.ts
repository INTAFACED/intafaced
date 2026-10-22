import { timingSafeEqual } from 'node:crypto';
import { transaction } from '@intafaced/db';
import type { Sql } from 'postgres';
import { AuthError } from './auth-service.js';
import { generateToken, hashToken } from './passwords.js';
import type { PasswordResetMail } from './password-reset.js';

/**
 * Signed-in email confirmation.
 *
 * `auth.requestEmailConfirmation` mails one high-entropy token to the session
 * user's own address. The response is `{ accepted: true }` whether or not a
 * message was handed to the mail port, so the call is not an account-existence
 * oracle. The token is stored only as a SHA-256. `auth.confirmEmail` sets
 * `email_verified_at` for that user and that address, once.
 *
 * Unset mail, lifetime, or rate budget refuses every caller the same way
 * (`auth.email_confirm_unwired`). Nothing here invents a lifetime or a cap.
 */

/** One day. Longer than that is not a confirmation proof. */
const MAX_TTL_SECONDS = 86_400;
/** Technical ceiling for an owner-published budget. Not a default. */
const MAX_RATE = 1_000;

const INVALID = 'That confirmation link is not valid. Request a new one.';
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

function instant(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function unwired(deps: EmailConfirmDeps): 'mail' | 'ttl' | 'rate' | null {
  if (!deps.mail) return 'mail';
  if (publishedEmailConfirmTtlSeconds(deps.ttlSeconds) === undefined) return 'ttl';
  if (publishedEmailConfirmRate(deps.rateMax, deps.rateWindowSeconds) === undefined) return 'rate';
  return null;
}

export async function requestEmailConfirmation(deps: EmailConfirmDeps, input: { userId: string }): Promise<{ accepted: true }> {
  const reason = unwired(deps);
  if (reason) {
    deps.log.warn({ reason }, 'auth.email_confirm_unwired');
    throw new AuthError('Email confirmation is not available yet', 'auth.email_confirm_unwired');
  }
  const mail = deps.mail!;
  const ttlSeconds = publishedEmailConfirmTtlSeconds(deps.ttlSeconds)!;
  const rate = publishedEmailConfirmRate(deps.rateMax, deps.rateWindowSeconds)!;
  const now = deps.now();
  const since = new Date(now.getTime() - rate.windowSeconds * 1000);

  const outcome = await transaction(
    deps.sql,
    async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('email-confirm'), hashtext(${input.userId}::text))`;
      const counted = await tx<Array<{ n: number; oldest: Date | string | null }>>`
        SELECT count(*)::int AS n, min(created_at) AS oldest FROM email_confirmation_attempts
        WHERE user_id = ${input.userId} AND created_at > ${since}
      `;
      if (Number(counted[0]?.n ?? 0) >= rate.max) {
        // The wait is until the oldest request in the window leaves it.
        const oldest = new Date(counted[0]!.oldest ?? now).getTime();
        return {
          kind: 'rate' as const,
          retryAfterSeconds: Math.max(1, Math.ceil((oldest + rate.windowSeconds * 1000 - now.getTime()) / 1000)),
        };
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
      const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
      await tx`
        INSERT INTO email_confirmation_proofs (user_id, code_hash, email_hash, expires_at, created_at)
        VALUES (${user.id}, ${hashToken(code)}, ${hashToken(normalizeConfirmEmail(user.email))}, ${expiresAt}, ${now})
      `;
      await tx`
        INSERT INTO email_confirmation_audit (user_id, event, reason, created_at)
        VALUES (${user.id}, 'requested', 'issued', ${now})
      `;
      return { kind: 'send' as const, email: user.email, code, expiresAt };
    },
    { isolation: 'read committed' },
  );

  if (outcome.kind === 'rate') {
    throw new AuthError('Too many confirmation emails. Try again later.', 'auth.email_confirm_rate_limited', {
      retryAfterSeconds: outcome.retryAfterSeconds,
    });
  }
  if (outcome.kind === 'silent') return { accepted: true };

  try {
    await mail.send({ email: outcome.email, code: outcome.code, expiresAt: outcome.expiresAt, purpose: 'email-confirm' });
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
        await tx`
          INSERT INTO email_confirmation_audit (user_id, event, reason, created_at)
          VALUES (${proof.user_id}, 'refused', 'reused', ${deps.now()})
        `;
        return { reason: 'reused' as const, userId: proof.user_id };
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

  if (result.reason !== 'confirmed' || !result.userId) {
    throw new AuthError(INVALID, 'auth.email_confirm_invalid');
  }
  return { userId: result.userId };
}
