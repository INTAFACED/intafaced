/**
 * Set an API key's end date. After that instant it cannot place.
 * Refuse if expiresAt is missing. No invented clock — never default to now.
 *
 * One writer for both doors (`expireApiKey` and the developer room's `developerKeys.setExpiry`): an end date at or
 * before the key's current one (or a first one on a key with none) only narrows the key and commits on its own; a
 * later one widens it and takes a fresh second factor, audited as `expiry_widen` in the same transaction. A revoked
 * or ended key never changes, so no end date can bring a key back.
 */
import type { Sql } from 'postgres';
import type { PayStepUpFactorProof } from './auth-service.js';
import { narrowOrGuardedChange, type ApiKeyFactorGate } from './api-key-fresh-factor.js';

export class ExpireApiKeyError extends Error {
  constructor(
    message: string,
    readonly code: 'auth.expires_at_missing' | 'auth.not_found' | 'identity.key_not_live',
  ) {
    super(message);
    this.name = 'ExpireApiKeyError';
  }
}

export function requireExpiresAt(value: Date | string | null | undefined): Date {
  if (value === null || value === undefined) {
    throw new ExpireApiKeyError('expiresAt is required', 'auth.expires_at_missing');
  }
  if (typeof value === 'string' && value.trim() === '') {
    throw new ExpireApiKeyError('expiresAt is required', 'auth.expires_at_missing');
  }
  const at = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(at.getTime())) {
    throw new ExpireApiKeyError('expiresAt is required', 'auth.expires_at_missing');
  }
  return at;
}

/** After expiresAt the key cannot place. Missing expiry stays open. */
export function apiKeyExpired(expiresAt: Date | null | undefined): boolean {
  if (!expiresAt) return false;
  return expiresAt.getTime() < Date.now();
}

/** True when `at` keeps the key no longer than its current end date (none counts as forever). */
export function expiryNarrows(current: Date | null, at: Date): boolean {
  return current === null || at.getTime() <= current.getTime();
}

export type ExpiryCaller = {
  readonly userId: string;
  readonly sid: string;
  readonly kid?: string | undefined;
  readonly sub_account?: string | undefined;
};

/**
 * The one end-date writer. The key row is locked; another account's key or a missing one is `auth.not_found`, a
 * revoked or ended key `identity.key_not_live`; an end date that narrows commits with no factor, one that widens needs
 * `proof` (`auth.step_up_required` without it). API keys and sub-accounts are refused before anything is read.
 */
export async function expireApiKey(
  deps: { sql: Sql; gate: ApiKeyFactorGate; now?: () => Date },
  caller: ExpiryCaller,
  keyId: string,
  expiresAt: Date | string | null | undefined,
  proof?: PayStepUpFactorProof,
): Promise<{ id: string; expiresAt: Date }> {
  const at = requireExpiresAt(expiresAt);
  const now = deps.now?.() ?? new Date();
  return narrowOrGuardedChange({
    sql: deps.sql,
    gate: deps.gate,
    caller,
    proof,
    action: { action: 'expiry_widen', keyId },
    readLocked: async (tx) => {
      const rows = await tx<Array<{ revoked: boolean; expires_at: Date | null }>>`
        SELECT revoked, expires_at FROM api_keys WHERE id = ${keyId} AND user_id = ${caller.userId} FOR UPDATE
      `;
      const row = rows[0];
      if (!row) throw new ExpireApiKeyError('API key not found', 'auth.not_found');
      if (row.revoked || (row.expires_at !== null && row.expires_at.getTime() <= now.getTime())) {
        throw new ExpireApiKeyError('This key is revoked or has ended; make a new key instead', 'identity.key_not_live');
      }
      return row.expires_at;
    },
    narrows: (current) => expiryNarrows(current, at),
    write: async (tx) => {
      const rows = await tx<Array<{ id: string; expires_at: Date }>>`
        UPDATE api_keys SET expires_at = ${at}
        WHERE id = ${keyId} AND user_id = ${caller.userId} AND revoked = false
        RETURNING id, expires_at
      `;
      const row = rows[0];
      if (!row) throw new ExpireApiKeyError('API key not found', 'auth.not_found');
      return { id: row.id, expiresAt: row.expires_at };
    },
  });
}
