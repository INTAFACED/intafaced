/**
 * Unenroll a stored passkey and revoke that user's live API keys.
 * Missing cred never revokes keys. Reuses unenrollPasskeyAndRevokeSessions
 * then revokeAllApiKeys. No invented key ids. Those keys cannot place.
 */
import type { Sql } from 'postgres';
import { unenrollPasskeyAndRevokeSessions } from './unenroll-passkey-sessions.js';
import { revokeAllApiKeys } from './revoke-all-api-keys.js';

export async function unenrollPasskeyAndRevokeKeys(
  sql: Sql,
  userId: string,
  credentialId: string | null | undefined,
): Promise<{ credentialId: string; remaining: number; sessionsRevoked: number; keysRevoked: number }> {
  const dropped = await unenrollPasskeyAndRevokeSessions(sql, userId, credentialId);
  const keys = await revokeAllApiKeys(sql, userId, userId);
  return { ...dropped, keysRevoked: keys.revoked };
}
