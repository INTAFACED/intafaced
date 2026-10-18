/**
 * Redeem a one-time recovery code to revoke all other live sessions.
 * The recovered session stays and must be live and owned by `userId`. Refuse if the code is spent
 * or missing. Reuses revokeSession. No invented session.
 * Spends the code through `redeemRecoveryCode` (recovery-redeem.ts): the `mfa` attempt is
 * reserved first, the code is claimed under `SELECT ... FOR UPDATE`, so it can never be
 * used twice, and a success clears the counter.
 */
import type { Sql } from 'postgres';
import { revokeSession } from './revoke-session.js';
import { assertOwnLiveSession, redeemRecoveryCode, type RecoveryRedeemCode } from './recovery-redeem.js';

export class RedeemRecoveryRevokeSessionsError extends Error {
  constructor(
    message: string,
    readonly code: RecoveryRedeemCode,
  ) {
    super(message);
    this.name = 'RedeemRecoveryRevokeSessionsError';
  }
}

const make = (message: string, code: RecoveryRedeemCode) => new RedeemRecoveryRevokeSessionsError(message, code);

export function recoveryCodeRevokesOtherSessions(code: unknown): void {
  const trimmed = typeof code === 'string' ? code.trim() : '';
  if (!trimmed) {
    throw make('Recovery code missing', 'auth.recovery_missing');
  }
}

export async function revokeOtherSessionsAfterRecoveryCode(
  sql: Sql,
  input: { userId: string; sessionId: string; code: string },
): Promise<{ userId: string; sessionId: string; revoked: number }> {
  recoveryCodeRevokesOtherSessions(input.code);
  const keep = (await assertOwnLiveSession(sql, input.userId, input.sessionId)).id;
  return redeemRecoveryCode(sql, { userId: input.userId, code: input.code, make }, async () => {
    const live = await sql<Array<{ id: string }>>`
      SELECT id FROM sessions WHERE user_id = ${input.userId} AND revoked = false
    `;
    let revoked = 0;
    for (const row of live) {
      if (row.id === keep) continue;
      if (await revokeSession(sql, input.userId, row.id)) revoked += 1;
    }
    return { userId: input.userId, sessionId: keep, revoked };
  });
}
