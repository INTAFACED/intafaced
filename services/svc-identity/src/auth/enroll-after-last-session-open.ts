/**
 * Open a live session only after the newly enrolled passkey verifies following a last-unenroll.
 * Refuse if none remain. Return a live session only when its owner is input.userId.
 * Reuses requireVerifiedPasskey and PlaceDoor.assertSessionLive.
 * No invented challenge. No invented session.
 */
import type { Sql } from 'postgres';
import { MintApiKeyPasskeyError, requireVerifiedPasskey } from './mint-api-key-passkey.js';
import { PlaceDoor, PlaceDoorError } from './place-door.js';

export function newlyEnrolledPasskeyOpensSession(raw: unknown): void {
  requireVerifiedPasskey(raw);
}

export async function openLiveSessionAfterNewlyEnrolledPasskey(
  sql: Sql,
  input: { userId: string; sessionId: string },
): Promise<{ id: string; userId: string }> {
  const rows = await sql<Array<{ webauthn_creds: unknown }>>`
    SELECT webauthn_creds FROM users WHERE id = ${input.userId} LIMIT 1
  `;
  const user = rows[0];
  if (!user) throw new MintApiKeyPasskeyError('User not found', 'auth.not_found');
  requireVerifiedPasskey(user.webauthn_creds);
  const live = await new PlaceDoor(sql).assertSessionLive(input.sessionId);
  if (live.userId !== input.userId) {
    throw new PlaceDoorError('Session not found', 'auth.session_denied');
  }
  return live;
}
