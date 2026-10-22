/**
 * Unenroll one of two passkeys without dropping the remaining cred's seats or keys.
 * Last remaining cred still revokes sessions and keys. Missing cred never revokes.
 * No ceremony. No invented challenge. No invented session/key ids.
 */
import type { Sql } from 'postgres';
import { unenrollPasskey } from './unenroll-passkey.js';
import { revokeAllSessions } from './revoke-all-sessions.js';
import { revokeAllApiKeys } from './revoke-all-api-keys.js';

export async function unenrollOneOfTwo(
  sql: Sql,
  userId: string,
  credentialId: string | null | undefined,
): Promise<{ credentialId: string; remaining: number; sessionsRevoked: number; keysRevoked: number }> {
  const dropped = await unenrollPasskey(sql, userId, credentialId);
  if (dropped.remaining > 0) {
    return { credentialId: dropped.credentialId, remaining: dropped.remaining, sessionsRevoked: 0, keysRevoked: 0 };
  }
  const sessions = await revokeAllSessions(sql, userId, userId);
  const keys = await revokeAllApiKeys(sql, userId, userId);
  return {
    credentialId: dropped.credentialId,
    remaining: dropped.remaining,
    sessionsRevoked: sessions.revoked,
    keysRevoked: keys.revoked,
  };
}
