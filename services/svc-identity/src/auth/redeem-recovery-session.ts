/**
 * Redeem a one-time recovery code to open a live session.
 * Refuse if the code is missing, spent, or wrong. Reuses hashToken and PlaceDoor.assertSessionLive.
 * No invented challenge. No invented session.
 */
import type { Sql } from 'postgres';
import { PlaceDoor } from './place-door.js';
import { hashToken } from './passwords.js';

export class RedeemRecoverySessionError extends Error {
  constructor(
    message: string,
    readonly code: 'auth.recovery_missing' | 'auth.recovery_spent' | 'auth.recovery_invalid' | 'auth.not_found',
  ) {
    super(message);
    this.name = 'RedeemRecoverySessionError';
  }
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

export function recoveryCodeOpensSession(code: unknown): void {
  const trimmed = typeof code === 'string' ? code.trim() : '';
  if (!trimmed) {
    throw new RedeemRecoverySessionError('Recovery code missing', 'auth.recovery_missing');
  }
}

export async function openLiveSessionAfterRecoveryCode(
  sql: Sql,
  input: { userId: string; sessionId: string; code: string },
): Promise<{ id: string; userId: string }> {
  recoveryCodeOpensSession(input.code);
  const rows = await sql<Array<{ recovery_code_hashes: unknown }>>`
    SELECT recovery_code_hashes FROM users WHERE id = ${input.userId} LIMIT 1
  `;
  const user = rows[0];
  if (!user) throw new RedeemRecoverySessionError('User not found', 'auth.not_found');
  const hashes = asStringList(user.recovery_code_hashes);
  if (hashes.length === 0) {
    throw new RedeemRecoverySessionError('Recovery code spent', 'auth.recovery_spent');
  }
  const hash = hashToken(input.code.trim());
  const idx = hashes.indexOf(hash);
  if (idx < 0) {
    throw new RedeemRecoverySessionError('Recovery code invalid', 'auth.recovery_invalid');
  }
  const live = await new PlaceDoor(sql).assertSessionLive(input.sessionId);
  const next = hashes.slice(0, idx).concat(hashes.slice(idx + 1));
  await sql`
    UPDATE users
       SET recovery_code_hashes = ${sql.json(next as never)}, updated_at = now()
     WHERE id = ${input.userId}
  `;
  return live;
}
