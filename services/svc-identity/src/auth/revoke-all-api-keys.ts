/**
 * Revoke every live API key for one named user. Compromise kill switch.
 * Already-revoked keys stay revoked. Missing userId refuses. No other user.
 */
import type { Sql } from 'postgres';

export class RevokeAllApiKeysError extends Error {
  constructor(
    message: string,
    readonly code: 'auth.user_id_missing',
  ) {
    super(message);
    this.name = 'RevokeAllApiKeysError';
  }
}

export function requireUserId(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    throw new RevokeAllApiKeysError('userId is required', 'auth.user_id_missing');
  }
  if (typeof value === 'string' && value.trim() === '') {
    throw new RevokeAllApiKeysError('userId is required', 'auth.user_id_missing');
  }
  return value.trim();
}

/** Every live key of the person, at their own request (panic, a recovery, a passkey removed): recorded as `owner`. */
export async function revokeAllApiKeys(
  sql: Sql,
  principalUserId: string | null | undefined,
  namedUserId: string | null | undefined,
): Promise<{ userId: string; revoked: number }> {
  const named = requireUserId(namedUserId);
  const principal = requireUserId(principalUserId);
  if (named !== principal) {
    return { userId: named, revoked: 0 };
  }
  const rows = await sql<Array<{ id: string }>>`
    UPDATE api_keys
    SET revoked = true, revoked_at = now(), revoked_cause = 'owner'
    WHERE user_id = ${named} AND revoked = false
    RETURNING id
  `;
  return { userId: named, revoked: rows.length };
}
