/**
 * Unenroll a stored passkey so later mint, rotate, and session verify refuse it.
 * No ceremony. No invented challenge. Remaining creds stay in place.
 */
import { transaction } from '@intafaced/db';
import type { Sql } from 'postgres';
import { assertLeavesAWayIn, lockedSigninMethods } from './signin-methods.js';
import { queueFactorChangedNotice } from './factor-changed-notice.js';

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
  // One transaction under a row lock: a racing login counter write or enrol
  // cannot overwrite this removal, and this removal cannot overwrite theirs.
  return transaction(sql, async (tx) => {
    const rows = await tx<Array<{ webauthn_creds: unknown }>>`
      SELECT webauthn_creds FROM users WHERE id = ${userId} FOR UPDATE
    `;
    const user = rows[0];
    if (!user) throw new UnenrollPasskeyError('User not found', 'auth.not_found');

    const existing = asCreds(user.webauthn_creds);
    if (existing.length === 0 || !existing.some((c) => c.credentialId === id)) {
      throw new UnenrollPasskeyError('No enrolled passkey', 'auth.passkey_missing');
    }

    // The last way in stays (I-account-lifecycle-07): a passkey is removed only while another method remains.
    assertLeavesAWayIn(await lockedSigninMethods(tx, userId));
    const remaining = existing.filter((c) => c.credentialId !== id);
    await tx`
      UPDATE users
         SET webauthn_creds = ${tx.json(remaining as never)}, updated_at = now()
       WHERE id = ${userId}
    `;
    await queueFactorChangedNotice(tx, { userId, change: 'passkey_removed', now: new Date() });
    return { credentialId: id, remaining: remaining.length };
  });
}
