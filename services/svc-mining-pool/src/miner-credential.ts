import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Sql } from 'postgres';
import { MiningError } from './errors.js';

/** The miner door refuses a missing, unissued or wrong secret with this one code, so it never says which. */
export const STRATUM_SECRET_INVALID = 'mining.stratum_secret_invalid';

/** A secret as the room shows it: a fixed prefix and 32 random bytes, base64url. */
const SECRET = /^msk_[A-Za-z0-9_-]{43}$/;
// Compared against when the account has no secret, so an unissued account costs the same as a wrong secret.
const NO_HASH = Buffer.alloc(32);

function hashOf(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

export type MinerSecretStatus = { readonly issuedAt: string | null };
export type IssuedMinerSecret = { readonly secret: string; readonly issuedAt: string };

/**
 * Issues a new miner secret for the account, replacing any earlier one (which stops working at once). The secret is
 * returned once and only its SHA-256 is stored.
 */
export async function issueMinerSecret(sql: Sql, accountId: string): Promise<IssuedMinerSecret> {
  const secret = `msk_${randomBytes(32).toString('base64url')}`;
  const hash = hashOf(secret).toString('hex');
  const [row] = await sql<{ issued_at: Date }[]>`
    INSERT INTO mining_pool.miner_credentials (account_id, secret_hash, issued_at)
    VALUES (${accountId}, ${hash}, now())
    ON CONFLICT (account_id) DO UPDATE SET secret_hash = EXCLUDED.secret_hash, issued_at = EXCLUDED.issued_at
    RETURNING issued_at
  `;
  if (!row) throw new MiningError('The miner secret was not issued', 'mining.miner_secret_not_issued');
  return { secret, issuedAt: row.issued_at.toISOString() };
}

/** When the account's current secret was issued, or null when none is. Never the secret or its hash. */
export async function minerSecretStatus(sql: Sql, accountId: string): Promise<MinerSecretStatus> {
  const [row] = await sql<{ issued_at: Date }[]>`
    SELECT issued_at FROM mining_pool.miner_credentials WHERE account_id = ${accountId}
  `;
  return { issuedAt: row ? row.issued_at.toISOString() : null };
}

/**
 * Refuses `mining.stratum_secret_invalid` unless `presented` is the account's current secret. It only reads the
 * credential row: no worker, share or lock is touched.
 */
export async function requireMinerSecret(sql: Sql, accountId: string, presented: unknown): Promise<void> {
  const [row] = await sql<{ secret_hash: string }[]>`
    SELECT secret_hash FROM mining_pool.miner_credentials WHERE account_id = ${accountId}
  `;
  const stored = row ? Buffer.from(row.secret_hash, 'hex') : NO_HASH;
  const shaped = typeof presented === 'string' && SECRET.test(presented);
  const given = hashOf(shaped ? presented : '');
  const match = timingSafeEqual(given, stored);
  if (!row || !shaped || !match) throw new MiningError('The miner secret is missing or wrong', STRATUM_SECRET_INVALID);
}
