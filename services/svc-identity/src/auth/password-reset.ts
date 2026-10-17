import { transaction } from '@intafaced/db';
import type { Sql } from 'postgres';
import { AuthError } from './auth-service.js';
import {
  assertPasswordShape,
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
 * The code is high-entropy and only the SHA-256 is stored. It is handed to the
 * mail port and must not be logged. There is no git-default lifetime: unset
 * TTL or no mail port refuses every address the same way (`auth.reset_unwired`).
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
    readonly purpose?: 'password-reset' | 'email-confirm';
  }): Promise<void>;
}

export interface PasswordResetDeps {
  readonly sql: Sql;
  readonly mail: PasswordResetMail | undefined;
  readonly ttlSeconds: number | undefined;
  readonly now: () => Date;
  readonly log: { warn(obj: Record<string, unknown>, msg: string): void };
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

function normalizeEmail(email: string): string {
  return email.trim();
}

/** Same cost and same error for every failed proof, so the answer does not say whether the email exists. */
async function rejectInvalidProof(newPassword: string): Promise<never> {
  await verifyPassword(await dummyPasswordHash(), newPassword);
  throw new AuthError(INVALID_PROOF, 'auth.reset_proof_invalid');
}

export async function requestPasswordReset(deps: PasswordResetDeps, input: { email: string }): Promise<{ accepted: true }> {
  const mail = deps.mail;
  const ttlSeconds = publishedPasswordResetTtlSeconds(deps.ttlSeconds);
  if (!mail || ttlSeconds === undefined) {
    deps.log.warn({ reason: !mail ? 'mail' : 'ttl' }, 'auth.password_reset_unwired');
    throw new AuthError('Password reset is not available yet', 'auth.reset_unwired');
  }

  const email = normalizeEmail(input.email);
  const rows = await deps.sql<Array<{ id: string; status: string; email: string }>>`
    SELECT id, status, email FROM users WHERE email = ${email}
  `;
  const user = rows[0];
  if (!user || user.status !== 'active') {
    hashToken(generateToken(32));
    return { accepted: true };
  }

  const code = generateToken(32);
  const codeHash = hashToken(code);
  const expiresAt = new Date(deps.now().getTime() + ttlSeconds * 1000);
  const inserted = await transaction(
    deps.sql,
    async (tx) => {
      const locked = await tx<Array<{ status: string }>>`
        SELECT status FROM users WHERE id = ${user.id} FOR UPDATE
      `;
      if (!locked[0] || locked[0].status !== 'active') return false;
      await tx`
        INSERT INTO password_reset_proofs (user_id, code_hash, expires_at)
        VALUES (${user.id}, ${codeHash}, ${expiresAt})
      `;
      return true;
    },
    { isolation: 'read committed' },
  );
  if (!inserted) return { accepted: true };

  try {
    await mail.send({ email: user.email, code, expiresAt });
  } catch {
    // A throw can follow a send that actually landed. Keep the proof.
    // The hash is unchanged and no session was minted.
    deps.log.warn({ userId: user.id }, 'auth.password_reset_delivery_failed');
  }
  return { accepted: true };
}

export async function completePasswordReset(
  deps: PasswordResetDeps,
  input: { email: string; code: string; newPassword: string },
): Promise<{ userId: string; sessionsRevoked: number }> {
  const email = normalizeEmail(input.email);
  const code = input.code.trim();
  const codeHash = hashToken(code);
  const now = deps.now();
  const rows = await deps.sql<Array<{ id: string; password_hash: string; status: string }>>`
    SELECT id, password_hash, status FROM users WHERE email = ${email}
  `;
  const user = rows[0];
  if (!user || user.status !== 'active' || code.length === 0) {
    return rejectInvalidProof(input.newPassword);
  }

  const proofs = await deps.sql<Array<{ id: string }>>`
    SELECT id FROM password_reset_proofs
    WHERE user_id = ${user.id}
      AND code_hash = ${codeHash}
      AND consumed_at IS NULL
      AND expires_at > ${now}
    LIMIT 1
  `;
  if (!proofs[0]) return rejectInvalidProof(input.newPassword);

  try {
    assertPasswordShape(input.newPassword);
  } catch (err) {
    if (err instanceof WeakPasswordError) throw new AuthError(err.message, 'auth.password_policy');
    throw err;
  }
  if (await verifyPassword(user.password_hash, input.newPassword)) {
    throw new AuthError('The new password must differ from the current one', 'auth.password_unchanged');
  }
  const nextHash = await hashPassword(input.newPassword);

  const revokedIds = await transaction(
    deps.sql,
    async (tx) => {
      const locked = await tx<Array<{ status: string }>>`
        SELECT status FROM users WHERE id = ${user.id} FOR UPDATE
      `;
      if (!locked[0] || locked[0].status !== 'active') {
        throw new AuthError(INVALID_PROOF, 'auth.reset_proof_invalid');
      }
      const proof = await tx<Array<{ id: string }>>`
        SELECT id FROM password_reset_proofs
        WHERE user_id = ${user.id}
          AND code_hash = ${codeHash}
          AND consumed_at IS NULL
          AND expires_at > ${deps.now()}
        FOR UPDATE
      `;
      if (!proof[0]) throw new AuthError(INVALID_PROOF, 'auth.reset_proof_invalid');
      await tx`UPDATE users SET password_hash = ${nextHash}, updated_at = now() WHERE id = ${user.id}`;
      await tx`
        UPDATE password_reset_proofs
        SET consumed_at = ${deps.now()}
        WHERE user_id = ${user.id} AND consumed_at IS NULL
      `;
      const revoked = await tx<Array<{ id: string }>>`
        UPDATE sessions SET revoked = true
        WHERE user_id = ${user.id} AND revoked = false
        RETURNING id
      `;
      return revoked.map((row) => row.id);
    },
    { isolation: 'read committed' },
  );

  return { userId: user.id, sessionsRevoked: revokedIds.length };
}
