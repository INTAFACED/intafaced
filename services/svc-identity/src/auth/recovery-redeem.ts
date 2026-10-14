/**
 * THE ONE SAFE WAY TO SPEND A RECOVERY CODE (outside sign-in itself).
 *
 * Failures this prevents:
 *  1. Online guessing. A recovery code was checked with no attempt counter, so a
 *     session holder could try codes without limit. Every redemption here first
 *     calls `reserveAttempt(sql, userId, 'mfa')` (attempt-lockout.ts): the guess
 *     is counted BEFORE it is checked, shares the budget with login and step-up,
 *     and a locked account is refused before any code is read.
 *  2. Double spend. The old modules did read-then-UPDATE with no lock, so two
 *     parallel redeems of the same code could both pass the check and both act.
 *     The claim below runs in one transaction that takes `SELECT ... FOR UPDATE`
 *     on the user row and removes the hash BEFORE the action runs. The second
 *     redeem waits for the row, then no longer finds the hash.
 *  3. Spent-but-undone. If the action itself fails after the code was claimed
 *     (key not found, mint refused), the hash is put back so the user does not
 *     lose a code to a failed request. A crash between claim and action burns
 *     the code instead (fail closed: a code can never be used twice).
 *
 * On a verified code the `mfa` counter is cleared (`recordSuccess`), exactly as
 * sign-in does. Any other exit leaves the reservation standing.
 */
import { transaction } from '@intafaced/db';
import type { Sql } from 'postgres';
import { recordSuccess, reserveAttempt } from './attempt-lockout.js';
import { hashToken } from './passwords.js';
import { PlaceDoor, PlaceDoorError } from './place-door.js';

export type RecoveryRedeemCode = 'auth.recovery_missing' | 'auth.recovery_spent' | 'auth.recovery_invalid' | 'auth.not_found';

/** Builds the caller's own error class, so each module keeps its public error type. */
export type RecoveryErrorFactory = (message: string, code: RecoveryRedeemCode) => Error;

export function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

/** Postgres foreign-key violation: the user row the attempt row points at does not exist. */
function isForeignKeyViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23503';
}

/**
 * Count the guess, then atomically take the code out of the user's stored hashes.
 * Resolves only for the single caller that removed it.
 */
async function claim(sql: Sql, userId: string, trimmed: string, make: RecoveryErrorFactory): Promise<void> {
  try {
    await reserveAttempt(sql, userId, 'mfa');
  } catch (err) {
    if (isForeignKeyViolation(err)) throw make('User not found', 'auth.not_found');
    throw err;
  }
  const hash = hashToken(trimmed);
  await transaction(sql, async (tx) => {
    const rows = await tx<Array<{ recovery_code_hashes: unknown }>>`
      SELECT recovery_code_hashes FROM users WHERE id = ${userId} FOR UPDATE
    `;
    const user = rows[0];
    if (!user) throw make('User not found', 'auth.not_found');
    const hashes = asStringList(user.recovery_code_hashes);
    if (hashes.length === 0) throw make('Recovery code spent', 'auth.recovery_spent');
    const idx = hashes.indexOf(hash);
    if (idx < 0) throw make('Recovery code invalid', 'auth.recovery_invalid');
    const next = hashes.slice(0, idx).concat(hashes.slice(idx + 1));
    await tx`UPDATE users SET recovery_code_hashes = ${tx.json(next as never)}, updated_at = now() WHERE id = ${userId}`;
  });
}

/** Put a claimed code back after its action failed. Idempotent: never adds a hash that is already there. */
async function refund(sql: Sql, userId: string, trimmed: string): Promise<void> {
  const hash = hashToken(trimmed);
  await transaction(sql, async (tx) => {
    const rows = await tx<Array<{ recovery_code_hashes: unknown }>>`
      SELECT recovery_code_hashes FROM users WHERE id = ${userId} FOR UPDATE
    `;
    if (!rows[0]) return;
    const hashes = asStringList(rows[0].recovery_code_hashes);
    if (hashes.includes(hash)) return;
    await tx`UPDATE users SET recovery_code_hashes = ${tx.json([...hashes, hash] as never)}, updated_at = now() WHERE id = ${userId}`;
  });
}

/**
 * Reserve an `mfa` attempt, spend `code` exactly once, clear the counter, then
 * run `act`. Throws (via `make`) when the code is missing, spent, wrong, or the
 * user is unknown; throws `auth.too_many_attempts` (AuthError) when locked.
 * Do every read-only precondition BEFORE calling this, so a refusal that has
 * nothing to do with the code never costs a guess or a code.
 */
export async function redeemRecoveryCode<T>(
  sql: Sql,
  input: { userId: string; code: unknown; make: RecoveryErrorFactory },
  act: () => Promise<T>,
): Promise<T> {
  const trimmed = typeof input.code === 'string' ? input.code.trim() : '';
  if (!trimmed) throw input.make('Recovery code missing', 'auth.recovery_missing');
  await claim(sql, input.userId, trimmed, input.make);
  await recordSuccess(sql, input.userId, 'mfa');
  try {
    return await act();
  } catch (err) {
    try {
      await refund(sql, input.userId, trimmed);
    } catch {
      // The original failure is the one the caller needs; an unrefunded code fails closed.
    }
    throw err;
  }
}

/**
 * The session must be live AND belong to `userId`. The old modules checked only
 * liveness, so a caller could name somebody else's live session. Read-only; call
 * it before `redeemRecoveryCode`.
 */
export async function assertOwnLiveSession(sql: Sql, userId: string, sessionId: string): Promise<{ id: string; userId: string }> {
  const live = await new PlaceDoor(sql).assertSessionLive(sessionId);
  if (live.userId !== userId) throw new PlaceDoorError('Session not found', 'auth.session_denied');
  return live;
}
