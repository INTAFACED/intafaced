/**
 * Disable one named user. Safety door: that user cannot mint or exchange keys.
 * Reuses users.status (frozen) — no second column. Revokes their live keys.
 * Does not freeze any other user. Does not invent keys on a later unfreeze.
 */
import type { Sql } from 'postgres';
import { AuthError, type AuthService } from './auth-service.js';
import { requireUserId } from './revoke-all-api-keys.js';
import { type DualControlCmd } from './four-eyes.js';
import { PrivilegedDualControlError, requirePrivilegedDualControl, type PrivilegedApprovalCmd } from './privileged-dual-control.js';
import type { ActionApprovalService } from './action-approval-service.js';

export class DisableUserError extends Error {
  constructor(
    message: string,
    readonly code: 'auth.user_id_missing' | 'auth.not_found' | 'identity.account_archived' | PrivilegedDualControlError['code'],
  ) {
    super(message);
    this.name = 'DisableUserError';
  }
}

export function requireDisableUserId(value: string | null | undefined): string {
  try {
    return requireUserId(value);
  } catch {
    throw new DisableUserError('userId is required', 'auth.user_id_missing');
  }
}

export async function disableUser(
  sql: Sql,
  namedUserId: string | null | undefined,
  cmd: PrivilegedApprovalCmd,
  approvals: Pick<ActionApprovalService, 'consume'>,
): Promise<{ userId: string; status: 'frozen'; keysRevoked: number }> {
  const named = requireDisableUserId(namedUserId);
  // An archived record stays closed for good: refuse before the approval is spent.
  const [archived] = await sql<Array<{ id: string }>>`SELECT id FROM users WHERE id = ${named} AND archived_at IS NOT NULL LIMIT 1`;
  if (archived) throw new DisableUserError('The customer record is archived and stays read-only', 'identity.account_archived');
  try {
    await requirePrivilegedDualControl(approvals, { ...cmd, targetId: cmd.targetId || 'identity.disable_user', fields: { userId: named } });
  } catch (err) {
    if (err instanceof PrivilegedDualControlError) {
      throw new DisableUserError(err.message, err.code);
    }
    throw err;
  }
  const users = await sql<Array<{ id: string }>>`
    SELECT id FROM users WHERE id = ${named} LIMIT 1
  `;
  if (!users[0]) {
    throw new DisableUserError('User not found', 'auth.not_found');
  }
  const frozen = await sql<Array<{ id: string }>>`
    UPDATE users SET status = 'frozen', updated_at = now() WHERE id = ${named} AND archived_at IS NULL RETURNING id
  `;
  // Archived between the check above and this write: nothing froze, so say so rather than answer 'frozen'.
  if (frozen.length === 0) throw new DisableUserError('The customer record is archived and stays read-only', 'identity.account_archived');
  // A frozen account must not keep live seats: refresh rotation and the session
  // door honour a live session, so revoke sessions with the keys. Passkeys stay on the account; the
  // frozen status blocks them and an unfreeze restores them.
  await sql`UPDATE sessions SET revoked = true WHERE user_id = ${named} AND revoked = false`;
  const rows = await sql<Array<{ id: string }>>`
    UPDATE api_keys
    SET revoked = true, revoked_at = now(), revoked_cause = 'account_freeze'
    WHERE user_id = ${named} AND revoked = false
    RETURNING id
  `;
  return { userId: named, status: 'frozen', keysRevoked: rows.length };
}

/** Mint refuses a frozen/closed/missing user without rewriting auth-service.ts. */
export function installDisabledMintRefuse(auth: AuthService, sql: Sql): void {
  const orig = auth.createApiKey.bind(auth);
  auth.createApiKey = async (input) => {
    const users = await sql<Array<{ status: string }>>`
      SELECT status FROM users WHERE id = ${input.userId} LIMIT 1
    `;
    const user = users[0];
    if (!user) throw new AuthError('User not found', 'auth.not_found');
    if (user.status !== 'active') throw new AuthError(`Account is ${user.status}`, 'auth.account_frozen');
    return orig(input);
  };
}
