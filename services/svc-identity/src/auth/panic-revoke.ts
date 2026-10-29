/**
 * Panic door: revoke every live API key and every live session for one named user.
 * Reuses revokeAllApiKeys + revokeAllSessions — does not fork their UPDATE.
 * Missing userId refuses. Other users untouched.
 */
import type { Sql } from 'postgres';
import { requireUserId, revokeAllApiKeys } from './revoke-all-api-keys.js';
import { revokeAllSessions } from './revoke-all-sessions.js';

export class PanicRevokeError extends Error {
  constructor(
    message: string,
    readonly code: 'auth.user_id_missing',
  ) {
    super(message);
    this.name = 'PanicRevokeError';
  }
}

export function requirePanicUserId(value: string | null | undefined): string {
  try {
    return requireUserId(value);
  } catch {
    throw new PanicRevokeError('userId is required', 'auth.user_id_missing');
  }
}

export async function panicRevoke(
  sql: Sql,
  principalUserId: string | null | undefined,
  namedUserId: string | null | undefined,
  cause: 'owner' | 'delegate' = 'owner',
): Promise<{ userId: string; keysRevoked: number; sessionsRevoked: number }> {
  const named = requirePanicUserId(namedUserId);
  const principal = requirePanicUserId(principalUserId);
  const keys = await revokeAllApiKeys(sql, principal, named, cause);
  const sessions = await revokeAllSessions(sql, principal, named);
  return { userId: named, keysRevoked: keys.revoked, sessionsRevoked: sessions.revoked };
}

export const revokeAllAccess = panicRevoke;
