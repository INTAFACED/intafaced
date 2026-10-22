/**
 * Unenroll a stored passkey and revoke that user's live sessions.
 * Missing cred never revokes. Reuses unenrollPasskey then revokeAllSessions.
 * No invented session ids. Those seats cannot place.
 */
import type { Sql } from 'postgres';
import { unenrollPasskey } from './unenroll-passkey.js';
import { revokeAllSessions } from './revoke-all-sessions.js';

export async function unenrollPasskeyAndRevokeSessions(
  sql: Sql,
  userId: string,
  credentialId: string | null | undefined,
): Promise<{ credentialId: string; remaining: number; sessionsRevoked: number }> {
  const dropped = await unenrollPasskey(sql, userId, credentialId);
  const sessions = await revokeAllSessions(sql, userId, userId);
  return {
    credentialId: dropped.credentialId,
    remaining: dropped.remaining,
    sessionsRevoked: sessions.revoked,
  };
}
