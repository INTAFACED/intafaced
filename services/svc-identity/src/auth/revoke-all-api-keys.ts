/**
 * Revoke every live API key for one named user. Compromise kill switch.
 * Already-revoked keys stay revoked. Missing userId refuses. No other user.
 */
import type { ApiKeyRevokedBy } from '@intafaced/contracts/api-keys';
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

/**
 * Who a revoke door's caller is, as the key list says it: the person signed in on a device (`owner`), or one of the
 * account's API keys or sub-accounts (`delegate`), so a key that switches off its siblings never reads "Revoked by you".
 */
export function revokeCauseOf(principal: {
  kid?: string | null | undefined;
  sub_account?: string | null | undefined;
}): 'owner' | 'delegate' {
  return principal.kid || principal.sub_account ? 'delegate' : 'owner';
}

/**
 * Every live key of the person: at their own request (panic, a recovery code, a passkey removed) recorded as `owner`,
 * as `delegate` when one of the account's keys or sub-accounts asked, or as `support` when our team's account recovery
 * does it.
 */
export async function revokeAllApiKeys(
  sql: Sql,
  principalUserId: string | null | undefined,
  namedUserId: string | null | undefined,
  cause: Extract<ApiKeyRevokedBy, 'owner' | 'delegate' | 'support'> = 'owner',
): Promise<{ userId: string; revoked: number }> {
  const named = requireUserId(namedUserId);
  const principal = requireUserId(principalUserId);
  if (named !== principal) {
    return { userId: named, revoked: 0 };
  }
  // The cause is written as a literal, one statement per cause, so the user id stays the statement's only value.
  const rows =
    cause === 'support'
      ? await sql<Array<{ id: string }>>`
          UPDATE api_keys
          SET revoked = true, revoked_at = now(), revoked_cause = 'support'
          WHERE user_id = ${named} AND revoked = false
          RETURNING id
        `
      : cause === 'delegate'
        ? await sql<Array<{ id: string }>>`
          UPDATE api_keys
          SET revoked = true, revoked_at = now(), revoked_cause = 'delegate'
          WHERE user_id = ${named} AND revoked = false
          RETURNING id
        `
        : await sql<Array<{ id: string }>>`
          UPDATE api_keys
          SET revoked = true, revoked_at = now(), revoked_cause = 'owner'
          WHERE user_id = ${named} AND revoked = false
          RETURNING id
        `;
  return { userId: named, revoked: rows.length };
}
