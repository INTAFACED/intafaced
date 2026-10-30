import postgres from 'postgres';
import { QUANT_DATABASE_POOL_MAX_UNSET, QUANT_DATABASE_URL_UNSET, QuantError } from '../errors.js';
import { createPostgresStrategyRepository } from './postgres-repository.js';
import type { StrategyRepository } from './repository.js';

function refuse(code: typeof QUANT_DATABASE_URL_UNSET | typeof QUANT_DATABASE_POOL_MAX_UNSET, detail: string): StrategyRepository {
  const fail = (): never => {
    throw new QuantError(code, detail);
  };
  return {
    replay: async () => fail(),
    create: async () => fail(),
    revise: async () => fail(),
    softDelete: async () => fail(),
    organise: async () => fail(),
    restore: async () => fail(),
    listDeleted: async () => fail(),
    list: async () => fail(),
    get: async () => fail(),
    versions: async () => fail(),
    operatorList: async () => fail(),
    saveBacktest: async () => fail(),
  };
}

/**
 * Paper strategy store. No URL means studio writes refuse by name.
 * Pool size is never invented: a URL without DATABASE_POOL_MAX refuses too.
 */
export function openStrategyRepository(env: { DATABASE_URL?: string | undefined; DATABASE_POOL_MAX?: string | undefined }): {
  repository: StrategyRepository;
  close: () => Promise<void>;
} {
  const url = env.DATABASE_URL?.trim();
  if (!url) {
    return { repository: refuse(QUANT_DATABASE_URL_UNSET, 'DATABASE_URL is unset'), close: async () => undefined };
  }
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
  return {
    repository: createPostgresStrategyRepository(sql),
    close: () => sql.end({ timeout: 5 }),
  };
}
