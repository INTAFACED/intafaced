/**
 * Drop all other drop-copy streams when a recovery code revokes the other sessions.
 * The recovered session's drop-copy stays. Refuse if the code is spent, missing,
 * or not one of the recovery hashes.
 * Not a redo of recovery-drop-other-streams (private /private/stream)
 * or recovery-mint-key-revoke-stream (drop-copy key revoke).
 */
import { createHash } from 'node:crypto';

export class RecoveryCodeDropCopyStreamError extends Error {
  constructor(
    message: string,
    readonly code: 'auth.recovery_missing' | 'auth.recovery_spent' | 'auth.recovery_invalid',
  ) {
    super(message);
    this.name = 'RecoveryCodeDropCopyStreamError';
  }
}

/** SHA-256 hex, same lookup key as a stored recovery code hash. Not a password hash. */
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

interface DropCopySeat {
  readonly sessionId: string;
  readonly drop: () => void;
}

function asSeats(value: unknown): DropCopySeat[] {
  if (!Array.isArray(value)) return [];
  const seats: DropCopySeat[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const sessionId = (item as { sessionId?: unknown }).sessionId;
    const drop = (item as { drop?: unknown }).drop;
    if (typeof sessionId !== 'string' || typeof drop !== 'function') continue;
    const id = sessionId.trim();
    if (!id) continue;
    seats.push({ sessionId: id, drop: drop as () => void });
  }
  return seats;
}

export function recoveryCodeDropsOtherDropCopyStreams(input: {
  code?: unknown;
  recoveryCodeHashes?: unknown;
  recoveredSessionId?: unknown;
  subscriptions?: unknown;
}): { keptSessionId: string; droppedSessionIds: string[] } {
  const trimmed = typeof input.code === 'string' ? input.code.trim() : '';
  if (!trimmed) {
    throw new RecoveryCodeDropCopyStreamError('Recovery code missing', 'auth.recovery_missing');
  }
  const hashes = asStringList(input.recoveryCodeHashes);
  if (hashes.length === 0) {
    throw new RecoveryCodeDropCopyStreamError('Recovery code spent', 'auth.recovery_spent');
  }
  if (!hashes.includes(hashRecoveryCode(trimmed))) {
    throw new RecoveryCodeDropCopyStreamError('Recovery code invalid', 'auth.recovery_invalid');
  }
  const keep = typeof input.recoveredSessionId === 'string' ? input.recoveredSessionId.trim() : '';
  const droppedSessionIds: string[] = [];
  for (const seat of asSeats(input.subscriptions)) {
    if (seat.sessionId === keep) continue;
    seat.drop();
    droppedSessionIds.push(seat.sessionId);
  }
  return { keptSessionId: keep, droppedSessionIds };
}
