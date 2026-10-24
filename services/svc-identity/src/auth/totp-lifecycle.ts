/**
 * Authenticator app lifecycle (I-signin-sessions-11): status, rename, replace, disable.
 *
 * Proof of the current authenticator is a TOTP code or a recovery code, counted on the MFA lockout
 * BEFORE the code is looked at (a wrong code is a failure there, a right one clears it). Every
 * write runs under the user's row lock, so the proof, the replay check and the change are one step.
 * Replace is two-phase: start parks the new secret (hash only) in the pending store; confirm
 * proves the new code and the old proof, then swaps. A crash or a wrong code before the swap leaves
 * the old secret live. The swap also mints new recovery codes (shown once, in the answer; the old ones stop working) and
 * ends every other session of the account (J-identity-05 #4: the lost phone is signed out). Owner enforcement of a second factor (slice 14) does not exist yet, so it is
 * treated as not required; a disable that leaves the account with a passkey or nothing is allowed.
 * Secrets and codes are never logged or returned except the new secret at replace start.
 */
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { AuthError } from './auth-service.js';
import { hashToken } from './passwords.js';
import { recordSuccess, reserveAttempt } from './attempt-lockout.js';
import type { PendingTotpEnrolmentStore } from './pending-totp-store.js';
import { generateRecoveryCodes, generateSecret, matchTotpStep, totpUri } from './totp.js';
import { encryptTotpSecret, materializeTotpSecret } from './totp-crypto.js';
import { syncNavigatorSessionClosed } from '../agents/navigator-session-projection-sync.js';

export const TOTP_LABEL_MAX = 64;
const CONTROL_OR_LINE_SEPARATOR = /[\p{Cc}\p{Zl}\p{Zp}]/u;

export class TotpLifecycleError extends Error {
  constructor(
    readonly code: 'auth.not_found' | 'auth.account_frozen' | 'auth.mfa_not_enrolled' | 'identity.totp_label_invalid',
    message: string = code,
  ) {
    super(message);
    this.name = 'TotpLifecycleError';
  }
}

export function normalizeTotpLabel(raw: string): string {
  const label = raw.trim();
  if (label.length < 1 || label.length > TOTP_LABEL_MAX || CONTROL_OR_LINE_SEPARATOR.test(label)) {
    throw new TotpLifecycleError('identity.totp_label_invalid');
  }
  return label;
}

export type TotpStatus = { enabled: boolean; label: string | null; enrolledAt: string | null; recoveryCodesLeft: number };

export type TotpLifecycleDeps = {
  readonly sql: Sql;
  readonly key: Buffer | null;
  readonly pending: PendingTotpEnrolmentStore;
  readonly now?: () => Date;
};

type UserRow = {
  status: string;
  email: string;
  totp_secret: string | null;
  totp_label: string | null;
  totp_enrolled_at: Date | null;
  totp_last_step: string | number | bigint | null;
  recovery_code_hashes: unknown;
};

const asHashes = (raw: unknown): string[] => (Array.isArray(raw) ? raw.filter((h): h is string => typeof h === 'string') : []);

function requireKey(key: Buffer | null): Buffer {
  if (!key) throw new AuthError('IDENTITY_TOTP_SECRET_KEY is not set to a 32-byte key (base64 or hex)', 'auth.totp_key_missing');
  return key;
}

export class TotpLifecycle {
  constructor(private readonly deps: TotpLifecycleDeps) {}

  private async lock(tx: Sql, userId: string): Promise<UserRow> {
    const rows = await tx<UserRow[]>`
      SELECT status, email, totp_secret, totp_label, totp_enrolled_at, totp_last_step, recovery_code_hashes
      FROM users WHERE id = ${userId} FOR UPDATE`;
    if (!rows[0]) throw new TotpLifecycleError('auth.not_found');
    return rows[0];
  }

  async status(userId: string): Promise<TotpStatus> {
    const rows = await this.deps.sql<UserRow[]>`
      SELECT status, email, totp_secret, totp_label, totp_enrolled_at, totp_last_step, recovery_code_hashes FROM users WHERE id = ${userId}`;
    const u = rows[0];
    if (!u) throw new TotpLifecycleError('auth.not_found');
    return {
      enabled: u.totp_secret !== null,
      label: u.totp_label,
      enrolledAt: u.totp_enrolled_at ? u.totp_enrolled_at.toISOString() : null,
      recoveryCodesLeft: u.totp_secret ? asHashes(u.recovery_code_hashes).length : 0,
    };
  }

  /** Cheap pre-check used before the step-up guard: is there an authenticator to act on? */
  async isEnabled(userId: string): Promise<boolean> {
    const rows = await this.deps.sql<Array<{ on: boolean }>>`SELECT totp_secret IS NOT NULL AS "on" FROM users WHERE id = ${userId}`;
    if (!rows[0]) throw new TotpLifecycleError('auth.not_found');
    return rows[0].on;
  }

  async rename(userId: string, rawLabel: string): Promise<TotpStatus> {
    const label = normalizeTotpLabel(rawLabel);
    await transaction(this.deps.sql, async (tx) => {
      const u = await this.lock(tx, userId);
      if (u.status !== 'active') throw new TotpLifecycleError('auth.account_frozen');
      if (!u.totp_secret) throw new TotpLifecycleError('auth.not_found');
      if (u.totp_label !== label) await tx`UPDATE users SET totp_label = ${label}, updated_at = now() WHERE id = ${userId}`;
    });
    return this.status(userId);
  }

  /**
   * Count one MFA attempt, then prove the current authenticator inside the locked write. Returns whether a
   * recovery code was spent. The TOTP step is recorded so the same code cannot be replayed.
   */
  private async proveCurrent(tx: Sql, userId: string, u: UserRow, code: string): Promise<{ recoveryCodeSpent: boolean }> {
    const secret = this.openSecret(u.totp_secret!);
    const matched = secret === null ? null : matchTotpStep(secret, code);
    if (matched !== null) {
      const last = u.totp_last_step === null ? null : BigInt(u.totp_last_step);
      if (last === null || matched > last) {
        await tx`UPDATE users SET totp_last_step = ${matched.toString()} WHERE id = ${userId}`;
        return { recoveryCodeSpent: false };
      }
      throw new AuthError('Invalid two-factor code', 'auth.mfa_invalid');
    }
    const hash = hashToken(code.trim());
    const hashes = asHashes(u.recovery_code_hashes);
    const idx = hashes.indexOf(hash);
    if (idx < 0) throw new AuthError('Invalid two-factor code', 'auth.mfa_invalid');
    const next = hashes.slice(0, idx).concat(hashes.slice(idx + 1));
    await tx`UPDATE users SET recovery_code_hashes = ${tx.json(next as never)} WHERE id = ${userId}`;
    u.recovery_code_hashes = next;
    return { recoveryCodeSpent: true };
  }

  private openSecret(stored: string): string | null {
    try {
      return materializeTotpSecret(this.deps.key, stored);
    } catch {
      return null;
    }
  }

  /** Off, proven by the current code or a recovery code. Already off answers ok. The proof throws inside the
   *  transaction, so a wrong code changes nothing, but the attempt was counted first and stays counted. */
  async disable(userId: string, code: string): Promise<{ disabled: true; recoveryCodeSpent: boolean }> {
    if (!(await this.isEnabled(userId))) return { disabled: true, recoveryCodeSpent: false };
    await reserveAttempt(this.deps.sql, userId, 'mfa');
    const outcome = await transaction(this.deps.sql, async (tx) => {
      const u = await this.lock(tx, userId);
      if (u.status !== 'active') throw new TotpLifecycleError('auth.account_frozen');
      if (!u.totp_secret) return { recoveryCodeSpent: false };
      const proof = await this.proveCurrent(tx, userId, u, code);
      await tx`UPDATE users SET totp_secret = NULL, totp_label = NULL, totp_enrolled_at = NULL, totp_last_step = NULL,
        recovery_code_hashes = '[]'::jsonb, updated_at = now() WHERE id = ${userId}`;
      return proof;
    });
    await recordSuccess(this.deps.sql, userId, 'mfa');
    return { disabled: true, ...outcome };
  }

  /** Phase one: park a new secret. Nothing about the live authenticator changes. */
  async replaceStart(userId: string): Promise<{ secret: string; uri: string }> {
    requireKey(this.deps.key);
    const rows = await this.deps.sql<Array<{ email: string; status: string; totp_secret: string | null }>>`
      SELECT email, status, totp_secret FROM users WHERE id = ${userId}`;
    const u = rows[0];
    if (!u) throw new TotpLifecycleError('auth.not_found');
    if (u.status !== 'active') throw new TotpLifecycleError('auth.account_frozen');
    if (!u.totp_secret) throw new TotpLifecycleError('auth.mfa_not_enrolled');
    const secret = generateSecret();
    await this.deps.pending.put(userId, hashToken(secret), []);
    return { secret, uri: totpUri(secret, u.email) };
  }

  /**
   * The new code is checked before anything is counted or written; then the old proof; then, in one transaction, the swap,
   * new recovery codes in place of the old ones, the end of every session but `keepSessionId` (the one replacing), and the
   * end of every device's trust but that session's.
   */
  async replaceConfirm(
    userId: string,
    input: { secret: string; newCode: string; currentCode: string },
    keepSessionId: string | null = null,
  ): Promise<{ replaced: true; recoveryCodeSpent: boolean; recoveryCodes: string[]; sessionsEnded: number }> {
    const key = requireKey(this.deps.key);
    const matchedNew = matchTotpStep(input.secret, input.newCode);
    if (matchedNew === null) throw new AuthError('Invalid two-factor code', 'auth.mfa_invalid');
    await reserveAttempt(this.deps.sql, userId, 'mfa');
    const outcome = await transaction(this.deps.sql, async (tx) => {
      const u = await this.lock(tx, userId);
      if (u.status !== 'active') throw new TotpLifecycleError('auth.account_frozen');
      if (!u.totp_secret) throw new TotpLifecycleError('auth.mfa_not_enrolled');
      const proof = await this.proveCurrent(tx, userId, u, input.currentCode);
      const held = await this.deps.pending.takeIfSecretHash(userId, hashToken(input.secret));
      if (!held) throw new AuthError('TOTP replacement expired or secret mismatch — start again', 'auth.mfa_invalid');
      const recoveryCodes = generateRecoveryCodes();
      await tx`UPDATE users SET totp_secret = ${encryptTotpSecret(key, input.secret)}, totp_last_step = ${matchedNew.toString()},
        totp_enrolled_at = now(), recovery_code_hashes = ${tx.json(recoveryCodes.map((c) => hashToken(c)) as never)},
        updated_at = now() WHERE id = ${userId}`;
      const ended = await tx<Array<{ id: string }>>`
        UPDATE sessions SET revoked = true
        WHERE user_id = ${userId} AND revoked = false AND id IS DISTINCT FROM ${keepSessionId}::uuid
        RETURNING id`;
      // A lost phone stays trusted no longer: every device but the one replacing asks for approval at its next sign-in.
      await tx`
        UPDATE trusted_devices SET removed_at = now()
        WHERE user_id = ${userId} AND removed_at IS NULL
          AND id IS DISTINCT FROM (SELECT trusted_device_id FROM sessions WHERE id = ${keepSessionId}::uuid)`;
      return { ...proof, recoveryCodes, ended: ended.map((r) => r.id) };
    });
    await recordSuccess(this.deps.sql, userId, 'mfa');
    for (const sessionId of outcome.ended) await syncNavigatorSessionClosed(this.deps.sql, sessionId);
    return {
      replaced: true,
      recoveryCodeSpent: outcome.recoveryCodeSpent,
      recoveryCodes: outcome.recoveryCodes,
      sessionsEnded: outcome.ended.length,
    };
  }
}
