import postgres from 'postgres';
import { QUANT_DATABASE_POOL_MAX_UNSET, QUANT_DATABASE_URL_UNSET, QuantError } from '../errors.js';
import { createPostgresTemplateRepository } from './postgres-repository.js';
import type { TemplateRepository } from './repository.js';

function refuse(code: typeof QUANT_DATABASE_URL_UNSET | typeof QUANT_DATABASE_POOL_MAX_UNSET, detail: string): TemplateRepository {
  const fail = (): never => {
    throw new QuantError(code, detail);
  };
  return { publish: async () => fail(), list: async () => fail(), get: async () => fail() };
}

/** Template store. No URL means reads and writes refuse by name; the pool size is never invented. */
export function openTemplateRepository(env: { DATABASE_URL?: string | undefined; DATABASE_POOL_MAX?: string | undefined }): {
  repository: TemplateRepository;
  close: () => Promise<void>;
} {
  const url = env.DATABASE_URL?.trim();
  if (!url) return { repository: refuse(QUANT_DATABASE_URL_UNSET, 'DATABASE_URL is unset'), close: async () => undefined };
  const rawPool = env.DATABASE_POOL_MAX?.trim() ?? '';
  const pool = Number(rawPool);
  if (!rawPool || !Number.isInteger(pool) || pool < 1 || pool > 200) {
    return {
      repository: refuse(QUANT_DATABASE_POOL_MAX_UNSET, 'DATABASE_POOL_MAX must be an integer from 1 to 200'),
      close: async () => undefined,
    };
  }
  const sql = postgres(url, { max: pool, onnotice: () => undefined });
  return { repository: createPostgresTemplateRepository(sql), close: () => sql.end({ timeout: 5 }) };
}
