/**
 * Unenroll a stored passkey so later mint, rotate, and session verify refuse it.
 * No ceremony. No invented challenge. Remaining creds stay in place.
 */
import type { Sql } from 'postgres';

export class UnenrollPasskeyError extends Error {
  constructor(
    message: string,
    readonly code: 'auth.not_found' | 'auth.passkey_missing' | 'auth.credential_id_missing',
  ) {
    super(message);
    this.name = 'UnenrollPasskeyError';
  }
}

type StoredCred = { credentialId?: unknown };

function asCreds(raw: unknown): StoredCred[] {
  return Array.isArray(raw) ? (raw as StoredCred[]) : [];
}

function requireCredentialId(value: string | null | undefined): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new UnenrollPasskeyError('credentialId is required', 'auth.credential_id_missing');
  }
  return value.trim();
}

export async function unenrollPasskey(
  sql: Sql,
  userId: string,
  credentialId: string | null | undefined,
): Promise<{ credentialId: string; remaining: number }> {
  const id = requireCredentialId(credentialId);
  const rows = await sql<Array<{ webauthn_creds: unknown }>>`
    SELECT webauthn_creds FROM users WHERE id = ${userId}
  `;
  const user = rows[0];
  if (!user) throw new UnenrollPasskeyError('User not found', 'auth.not_found');

  const existing = asCreds(user.webauthn_creds);
  if (existing.length === 0 || !existing.some((c) => c.credentialId === id)) {
    throw new UnenrollPasskeyError('No enrolled passkey', 'auth.passkey_missing');
  }

  const remaining = existing.filter((c) => c.credentialId !== id);
  await sql`
    UPDATE users
       SET webauthn_creds = ${sql.json(remaining as never)}, updated_at = now()
     WHERE id = ${userId}
  `;
  return { credentialId: id, remaining: remaining.length };
}
