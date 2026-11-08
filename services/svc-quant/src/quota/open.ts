import postgres from 'postgres';
import { QUANT_DATABASE_POOL_MAX_UNSET, QUANT_DATABASE_URL_UNSET, QuantError } from '../errors.js';
import { createPostgresQuota } from './postgres.js';
import type { QuotaGate, QuotaRepository, QuotaSeed } from './quota.js';

function refuse(code: typeof QUANT_DATABASE_URL_UNSET | typeof QUANT_DATABASE_POOL_MAX_UNSET, detail: string): QuotaRepository {
  const fail = (): never => {
    throw new QuantError(code, detail);
  };
  return {
    applied: async () => fail(),
    counts: async () => fail(),
    limits: async () => fail(),
    set: async () => fail(),
    assign: async () => fail(),
  };
}

/**
 * Quota store and gate. No URL means quota reads and writes refuse by name (and so do the strategy and run writes the
 * gate would guard); the pool size is never invented.
 */
export function openQuota(
  env: { DATABASE_URL?: string | undefined; DATABASE_POOL_MAX?: string | undefined },
  options: { defaultProfile: string | null; seed: QuotaSeed | null },
): { repository: QuotaRepository; gate: QuotaGate | undefined; close: () => Promise<void> } {
  const url = env.DATABASE_URL?.trim();
  if (!url) return { repository: refuse(QUANT_DATABASE_URL_UNSET, 'DATABASE_URL is unset'), gate: undefined, close: async () => undefined };
  const rawPool = env.DATABASE_POOL_MAX?.trim() ?? '';
  const pool = Number(rawPool);
  if (!rawPool || !Number.isInteger(pool) || pool < 1 || pool > 200) {
    return {
      repository: refuse(QUANT_DATABASE_POOL_MAX_UNSET, 'DATABASE_POOL_MAX must be an integer from 1 to 200'),
      gate: undefined,
      close: async () => undefined,
    };
  }
  const sql = postgres(url, { max: pool, onnotice: () => undefined });
  const quota = createPostgresQuota(sql, { defaultProfile: options.defaultProfile, seed: options.seed });
  return { repository: quota.repository, gate: quota.gate, close: () => sql.end({ timeout: 5 }) };
}
