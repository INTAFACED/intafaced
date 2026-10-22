/**
 * Redeem a one-time recovery code to revoke all other live sessions.
 * The recovered session stays. Refuse if the code is spent or missing.
 * Reuses hashToken and revokeSession. No invented session.
 */
import type { Sql } from 'postgres';
import { hashToken } from './passwords.js';
import { revokeSession } from './revoke-session.js';

export class RedeemRecoveryRevokeSessionsError extends Error {
  constructor(
    message: string,
    readonly code: 'auth.recovery_missing' | 'auth.recovery_spent' | 'auth.recovery_invalid' | 'auth.not_found',
  ) {
    super(message);
    this.name = 'RedeemRecoveryRevokeSessionsError';
  }
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

export function recoveryCodeRevokesOtherSessions(code: unknown): void {
  const trimmed = typeof code === 'string' ? code.trim() : '';
  if (!trimmed) {
    throw new RedeemRecoveryRevokeSessionsError('Recovery code missing', 'auth.recovery_missing');
  }
}

export async function revokeOtherSessionsAfterRecoveryCode(
  sql: Sql,
  input: { userId: string; sessionId: string; code: string },
): Promise<{ userId: string; sessionId: string; revoked: number }> {
  recoveryCodeRevokesOtherSessions(input.code);
  const rows = await sql<Array<{ recovery_code_hashes: unknown }>>`
    SELECT recovery_code_hashes FROM users WHERE id = ${input.userId} LIMIT 1
  `;
  const user = rows[0];
  if (!user) throw new RedeemRecoveryRevokeSessionsError('User not found', 'auth.not_found');
  const hashes = asStringList(user.recovery_code_hashes);
  if (hashes.length === 0) {
    throw new RedeemRecoveryRevokeSessionsError('Recovery code spent', 'auth.recovery_spent');
  }
  const hash = hashToken(input.code.trim());
  const idx = hashes.indexOf(hash);
  if (idx < 0) {
    throw new RedeemRecoveryRevokeSessionsError('Recovery code invalid', 'auth.recovery_invalid');
  }
  const keep = input.sessionId.trim();
  const live = await sql<Array<{ id: string }>>`
    SELECT id
    FROM sessions
    WHERE user_id = ${input.userId} AND revoked = false
  `;
  let revoked = 0;
  for (const row of live) {
    if (row.id === keep) continue;
    if (await revokeSession(sql, input.userId, row.id)) revoked += 1;
  }
  const next = hashes.slice(0, idx).concat(hashes.slice(idx + 1));
  await sql`
    UPDATE users
       SET recovery_code_hashes = ${sql.json(next as never)}, updated_at = now()
     WHERE id = ${input.userId}
  `;
  return { userId: input.userId, sessionId: keep, revoked };
}
