import postgres from 'postgres';
import { QUANT_DATABASE_POOL_MAX_UNSET, QUANT_DATABASE_URL_UNSET, QuantError } from '../errors.js';
import { createPostgresRiskRepository } from './postgres-repository.js';
import type { RiskRepository } from './repository.js';

function refuse(code: typeof QUANT_DATABASE_URL_UNSET | typeof QUANT_DATABASE_POOL_MAX_UNSET, detail: string): RiskRepository {
  const fail = (): never => {
    throw new QuantError(code, detail);
  };
  return {
    get: async () => fail(),
    saveCaps: async () => fail(),
    setTrading: async () => fail(),
  };
}

/** Strategy risk screen store. No URL means every call refuses by name. Pool size is never invented. */
export function openRiskRepository(env: { DATABASE_URL?: string | undefined; DATABASE_POOL_MAX?: string | undefined }): {
  repository: RiskRepository;
  close: () => Promise<void>;
} {
  const url = env.DATABASE_URL?.trim();
  if (!url) return { repository: refuse(QUANT_DATABASE_URL_UNSET, 'DATABASE_URL is unset'), close: async () => undefined };
  const rawPool = env.DATABASE_POOL_MAX?.trim() ?? '';
  if (!rawPool) {
    return { repository: refuse(QUANT_DATABASE_POOL_MAX_UNSET, 'DATABASE_POOL_MAX is unset'), close: async () => undefined };
  }
  const pool = Number(rawPool);
  if (!Number.isInteger(pool) || pool < 1 || pool > 200) {
    return {
      repository: refuse(QUANT_DATABASE_POOL_MAX_UNSET, 'DATABASE_POOL_MAX must be an integer from 1 to 200'),
      close: async () => undefined,
    };
  }
  const sql = postgres(url, { max: pool, onnotice: () => undefined });
  return { repository: createPostgresRiskRepository(sql), close: () => sql.end({ timeout: 5 }) };
}
