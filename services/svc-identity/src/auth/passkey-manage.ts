/**
 * Passkey list and rename (I-signin-sessions-09), each passkey's purposes and the passkey second step (-10). The credentials live in `users.webauthn_creds`, so a
 * rename is a read-modify-write under the user's row lock: a rename racing a remove is decided by the
 * lock, and the loser answers `auth.not_found`.
 */
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { passkeyKind, type PasskeyKind, type StoredPasskey } from './enroll-passkey.js';
import { AuthError } from './auth-service.js';
import { purposesOf, type PasskeyPurpose } from './passkey-purposes.js';

export const PASSKEY_LABEL_MAX = 64;

export class PasskeyManageError extends Error {
  constructor(
    readonly code:
      | 'auth.not_found'
      | 'auth.account_frozen'
      | 'identity.passkey_label_invalid'
      | 'identity.passkey_purposes_invalid'
      | 'auth.webauthn_not_enrolled',
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
  purposes: PasskeyPurpose[];
};

type Raw = Partial<StoredPasskey> & { lastVerifiedAt?: unknown; purposes?: unknown };

function rowOf(c: Raw): PasskeyRow {
  return {
    credentialId: c.credentialId!,
    label: typeof c.label === 'string' ? c.label : null,
    kind: c.kind ?? passkeyKind(c.transports),
    createdAt: typeof c.createdAt === 'string' ? c.createdAt : '',
    lastUsedAt: typeof c.lastVerifiedAt === 'string' ? c.lastVerifiedAt : null,
    purposes: purposesOf(c),
  };
}

function asCreds(raw: unknown): Raw[] {
  return Array.isArray(raw) ? (raw as Raw[]).filter((c) => !!c && typeof c === 'object' && typeof c.credentialId === 'string') : [];
}

export async function listPasskeys(sql: Sql, userId: string, limit: number): Promise<PasskeyRow[]> {
  return (await passkeySettings(sql, userId, limit)).passkeys;
}

/**
 * The passkeys and whether sign-in asks for one after the password, from one read of the row. The second step is on
 * only while a passkey exists: with none, sign-in takes the password alone, and the list says so.
 */
export async function passkeySettings(sql: Sql, userId: string, limit: number): Promise<{ passkeys: PasskeyRow[]; secondStep: boolean }> {
  const rows = await sql<Array<{ webauthn_creds: unknown; passkey_second_step: boolean }>>`
    SELECT webauthn_creds, passkey_second_step FROM users WHERE id = ${userId}`;
  if (!rows[0]) throw new PasskeyManageError('auth.not_found');
  const creds = asCreds(rows[0].webauthn_creds);
  return {
    passkeys: creds
      .map(rowOf)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, limit),
    secondStep: rows[0].passkey_second_step && creds.length > 0,
  };
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
    return rowOf({ ...current, label });
  });
}

/**
 * Bind one passkey to the actions it answers for (I-signin-sessions-10); an empty list answers for every action no other
 * passkey is bound to. The same set again is a no-op that still answers the row.
 */
export async function setPasskeyPurposes(
  sql: Sql,
  userId: string,
  credentialId: string,
  purposes: readonly PasskeyPurpose[],
): Promise<PasskeyRow> {
  return transaction(sql, async (tx) => {
    const rows = await tx<Array<{ status: string; webauthn_creds: unknown }>>`
      SELECT status, webauthn_creds FROM users WHERE id = ${userId} FOR UPDATE`;
    if (!rows[0]) throw new PasskeyManageError('auth.not_found');
    if (rows[0].status !== 'active') throw new PasskeyManageError('auth.account_frozen');
    const creds = asCreds(rows[0].webauthn_creds);
    const current = creds.find((c) => c.credentialId === credentialId);
    if (!current) throw new PasskeyManageError('auth.not_found');
    const wanted = purposesOf({ purposes: [...purposes] });
    if (purposesOf(current).join(',') !== wanted.join(',')) {
      const next = creds.map((c) => (c.credentialId === credentialId ? { ...c, purposes: wanted } : c));
      await tx`UPDATE users SET webauthn_creds = ${tx.json(next as never)}, updated_at = now() WHERE id = ${userId}`;
    }
    return rowOf({ ...current, purposes: wanted });
  });
}

/**
 * Ask, or stop asking, for a passkey after the password at sign-in (I-signin-sessions-10). Turning it on needs a passkey
 * that answers for sign-in; with none left later, sign-in asks for the password alone again (or the authenticator).
 */
export async function setPasskeySecondStep(sql: Sql, userId: string, on: boolean): Promise<boolean> {
  return transaction(sql, async (tx) => {
    const rows = await tx<Array<{ status: string; webauthn_creds: unknown }>>`
      SELECT status, webauthn_creds FROM users WHERE id = ${userId} FOR UPDATE`;
    if (!rows[0]) throw new PasskeyManageError('auth.not_found');
    if (rows[0].status !== 'active') throw new PasskeyManageError('auth.account_frozen');
    if (on && asCreds(rows[0].webauthn_creds).length === 0) throw new PasskeyManageError('auth.webauthn_not_enrolled');
    await tx`UPDATE users SET passkey_second_step = ${on}, updated_at = now() WHERE id = ${userId}`;
    return on;
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
