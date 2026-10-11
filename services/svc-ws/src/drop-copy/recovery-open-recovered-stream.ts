/**
 * Open a drop-copy stream on the recovered session after a recovery redeem.
 * A matching recovery code authorizes that stream. A wrong, spent, or missing
 * code does not. Refuse closed when the session or token config is unset.
 * Not a redo of recovery-open-recovered-stream (private /private/stream).
 */
import { createHash } from 'node:crypto';
import { issueAccessToken, type TokenConfig } from '@intafaced/auth';

export class RecoveryCodeOpenDropCopyError extends Error {
  constructor(
    message: string,
    readonly code: 'auth.recovery_missing' | 'auth.recovery_spent' | 'auth.recovery_invalid',
  ) {
    super(message);
    this.name = 'RecoveryCodeOpenDropCopyError';
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

function tokenConfig(value: TokenConfig | null | undefined): TokenConfig | null {
  if (!value) return null;
  if (typeof value.secret !== 'string' || value.secret.length < 32) return null;
  if (typeof value.issuer !== 'string' || !value.issuer.trim()) return null;
  if (typeof value.audience !== 'string' || !value.audience.trim()) return null;
  if (typeof value.accessTtlSeconds !== 'number' || !(value.accessTtlSeconds > 0)) return null;
  return value;
}

export function recoveryCodeOpensRecoveredDropCopyStream(input: {
  code?: unknown;
  recoveryCodeHashes?: unknown;
  recoveredSessionId?: unknown;
  userId?: unknown;
  tokens?: TokenConfig | null;
}): Promise<{ accessToken: string; sessionId: string }> {
  const trimmed = typeof input.code === 'string' ? input.code.trim() : '';
  if (!trimmed) {
    throw new RecoveryCodeOpenDropCopyError('Recovery code missing', 'auth.recovery_missing');
  }
  const hashes = asStringList(input.recoveryCodeHashes);
  if (hashes.length === 0) {
    throw new RecoveryCodeOpenDropCopyError('Recovery code spent', 'auth.recovery_spent');
  }
  if (!hashes.includes(hashRecoveryCode(trimmed))) {
    throw new RecoveryCodeOpenDropCopyError('Recovery code invalid', 'auth.recovery_invalid');
  }
  const sessionId = typeof input.recoveredSessionId === 'string' ? input.recoveredSessionId.trim() : '';
  const userId = typeof input.userId === 'string' ? input.userId.trim() : '';
  const tokens = tokenConfig(input.tokens);
  if (!sessionId || !userId || !tokens) {
    throw new RecoveryCodeOpenDropCopyError('Recovered drop-copy stream is not authorized', 'auth.recovery_invalid');
  }
  return issueAccessToken({ userId, sessionId, scopes: ['trade:read'] }, tokens).then((issued) => ({
    accessToken: issued.token,
    sessionId,
  }));
}
