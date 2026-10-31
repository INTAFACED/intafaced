import postgres from 'postgres';
import { QUANT_DATABASE_POOL_MAX_UNSET, QUANT_DATABASE_URL_UNSET, QuantError } from '../errors.js';
import { RUN_RESERVE } from '../runs/limit.js';
import { createPostgresQuotaStore, type QuotaStore } from './postgres-store.js';

function refuse(code: typeof QUANT_DATABASE_URL_UNSET | typeof QUANT_DATABASE_POOL_MAX_UNSET, detail: string): QuotaStore {
  const fail = (): never => {
    throw new QuantError(code, detail);
  };
  return { setLimit: async () => fail(), assign: async () => fail(), usage: async () => fail() };
}

/** Quota profiles and assignments (AL-limits-01). No URL means every quota read and write refuses by name. */
export function openQuotaStore(
  env: { DATABASE_URL?: string | undefined; DATABASE_POOL_MAX?: string | undefined },
  defaultProfile: string | null,
): { store: QuotaStore; close: () => Promise<void> } {
  const url = env.DATABASE_URL?.trim();
  if (!url) return { store: refuse(QUANT_DATABASE_URL_UNSET, 'DATABASE_URL is unset'), close: async () => undefined };
  const rawPool = env.DATABASE_POOL_MAX?.trim() ?? '';
  const pool = Number(rawPool);
  if (!rawPool || !Number.isInteger(pool) || pool < 1 || pool > 200) {
    return {
      store: refuse(QUANT_DATABASE_POOL_MAX_UNSET, 'DATABASE_POOL_MAX must be an integer from 1 to 200'),
      close: async () => undefined,
    };
  }
  const sql = postgres(url, { max: pool, onnotice: () => undefined });
  return { store: createPostgresQuotaStore(sql, 'quant', defaultProfile, RUN_RESERVE), close: () => sql.end({ timeout: 5 }) };
}
