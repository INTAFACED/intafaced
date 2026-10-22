/**
 * Drop all other private streams when a recovery code revokes the other sessions.
 * The recovered session's stream stays. Refuse if the code is spent or missing.
 * Not a redo of revoke-all-keys.
 */
export class RecoveryCodeStreamError extends Error {
  constructor(
    message: string,
    readonly code: 'auth.recovery_missing' | 'auth.recovery_spent',
  ) {
    super(message);
    this.name = 'RecoveryCodeStreamError';
  }
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

export function recoveryCodeDropsOtherStreams(input: { code?: unknown; recoveryCodeHashes?: unknown }): void {
  const trimmed = typeof input.code === 'string' ? input.code.trim() : '';
  if (!trimmed) {
    throw new RecoveryCodeStreamError('Recovery code missing', 'auth.recovery_missing');
  }
  if (asStringList(input.recoveryCodeHashes).length === 0) {
    throw new RecoveryCodeStreamError('Recovery code spent', 'auth.recovery_spent');
  }
}
