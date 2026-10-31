import postgres from 'postgres';
import type { QuotaHold } from '../quota/postgres-store.js';
import { QUANT_DATABASE_POOL_MAX_UNSET, QUANT_DATABASE_URL_UNSET, QuantError } from '../errors.js';
import { assertRunResultCap, RUN_RESULT_MAX_BYTES } from './limit.js';
import { createPostgresRunRepository } from './postgres-repository.js';
import type { RunRepository } from './repository.js';

function refuse(code: typeof QUANT_DATABASE_URL_UNSET | typeof QUANT_DATABASE_POOL_MAX_UNSET, detail: string): RunRepository {
  const fail = (): never => {
    throw new QuantError(code, detail);
  };
  return {
    replay: async () => fail(),
    begin: async () => fail(),
    finish: async () => fail(),
    get: async () => fail(),
    list: async () => fail(),
    counts: async () => fail(),
    okKinds: async () => fail(),
    claimOnce: async () => fail(),
    history: async () => fail(),
    setLabel: async () => fail(),
    variantCount: async () => fail(),
  };
}

/**
 * Paper run store. No URL means run writes refuse by name.
 * Pool size is never invented. The result cap is the published constant,
 * not an environment default.
 */
export function openRunRepository(
  env: { DATABASE_URL?: string | undefined; DATABASE_POOL_MAX?: string | undefined },
  quota?: QuotaHold,
): {
  repository: RunRepository;
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
  assertRunResultCap(RUN_RESULT_MAX_BYTES);
  const sql = postgres(url, { max: pool, onnotice: () => undefined });
  return {
    repository: createPostgresRunRepository(sql, 'quant', RUN_RESULT_MAX_BYTES, quota),
    close: () => sql.end({ timeout: 5 }),
  };
}
