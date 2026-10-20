/**
 * Passkey list and rename (I-signin-sessions-09). The credentials live in `users.webauthn_creds`, so a
 * rename is a read-modify-write under the user's row lock: a rename racing a remove is decided by the
 * lock, and the loser answers `auth.not_found`.
 */
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { passkeyKind, type PasskeyKind, type StoredPasskey } from './enroll-passkey.js';
import { AuthError } from './auth-service.js';

export const PASSKEY_LABEL_MAX = 64;

export class PasskeyManageError extends Error {
  constructor(
    readonly code: 'auth.not_found' | 'auth.account_frozen' | 'identity.passkey_label_invalid',
    message: string = code,
  ) {
    super(message);
    this.name = 'PasskeyManageError';
  }
}

/** Control characters (Unicode category Cc) and the two line separators. */
const CONTROL_OR_LINE_SEPARATOR = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/** Trimmed, 1 to 64 characters, no control characters. */
export function normalizePasskeyLabel(raw: string): string {
  const label = raw.trim();
  if (label.length < 1 || label.length > PASSKEY_LABEL_MAX || CONTROL_OR_LINE_SEPARATOR.test(label)) {
    throw new PasskeyManageError('identity.passkey_label_invalid');
  }
  return label;
}

export type PasskeyRow = {
  credentialId: string;
  label: string | null;
  kind: PasskeyKind;
  createdAt: string;
  lastUsedAt: string | null;
};

type Raw = Partial<StoredPasskey> & { lastVerifiedAt?: unknown };

function asCreds(raw: unknown): Raw[] {
  return Array.isArray(raw) ? (raw as Raw[]).filter((c) => !!c && typeof c === 'object' && typeof c.credentialId === 'string') : [];
}

export async function listPasskeys(sql: Sql, userId: string, limit: number): Promise<PasskeyRow[]> {
  const rows = await sql<Array<{ webauthn_creds: unknown }>>`SELECT webauthn_creds FROM users WHERE id = ${userId}`;
  if (!rows[0]) throw new PasskeyManageError('auth.not_found');
  return asCreds(rows[0].webauthn_creds)
    .map((c) => ({
      credentialId: c.credentialId!,
      label: typeof c.label === 'string' ? c.label : null,
      kind: c.kind ?? passkeyKind(c.transports),
      createdAt: typeof c.createdAt === 'string' ? c.createdAt : '',
      lastUsedAt: typeof c.lastVerifiedAt === 'string' ? c.lastVerifiedAt : null,
    }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .slice(0, limit);
}

/** Same label on the same credential is a no-op that still answers the row. */
export async function renamePasskey(sql: Sql, userId: string, credentialId: string, rawLabel: string): Promise<PasskeyRow> {
  const label = normalizePasskeyLabel(rawLabel);
  return transaction(sql, async (tx) => {
    const rows = await tx<Array<{ status: string; webauthn_creds: unknown }>>`
      SELECT status, webauthn_creds FROM users WHERE id = ${userId} FOR UPDATE`;
    if (!rows[0]) throw new PasskeyManageError('auth.not_found');
    if (rows[0].status !== 'active') throw new PasskeyManageError('auth.account_frozen');
    const creds = asCreds(rows[0].webauthn_creds);
    const current = creds.find((c) => c.credentialId === credentialId);
    if (!current) throw new PasskeyManageError('auth.not_found');
    if (current.label !== label) {
      const next = creds.map((c) => (c.credentialId === credentialId ? { ...c, label } : c));
      await tx`UPDATE users SET webauthn_creds = ${tx.json(next as never)}, updated_at = now() WHERE id = ${userId}`;
    }
    return {
      credentialId,
      label,
      kind: current.kind ?? passkeyKind(current.transports),
      createdAt: typeof current.createdAt === 'string' ? current.createdAt : '',
      lastUsedAt: typeof current.lastVerifiedAt === 'string' ? current.lastVerifiedAt : null,
    };
  });
}

/** For `SecurityStepUp`: throws `auth.mfa_not_enrolled` when the account has neither a passkey nor an authenticator. */
export function requireEnrolledSecondFactor(sql: Sql): (userId: string) => Promise<void> {
  return async (userId) => {
    const rows = await sql<Array<{ totp_secret: string | null; totp_enrolled_at: Date | null; webauthn_creds: unknown }>>`
      SELECT totp_secret, totp_enrolled_at, webauthn_creds FROM users WHERE id = ${userId}`;
    const u = rows[0];
    const hasTotp = !!u && !!u.totp_secret && !!u.totp_enrolled_at;
    if (!u || (!hasTotp && asCreds(u.webauthn_creds).length === 0)) {
      throw new AuthError('Enrol a second factor first', 'auth.mfa_not_enrolled');
    }
  };
}
