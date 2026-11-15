import postgres from 'postgres';
import { QUANT_DATABASE_POOL_MAX_UNSET, QUANT_DATABASE_URL_UNSET, QuantError } from '../errors.js';
import { createPostgresLibraryRepository } from './postgres-repository.js';
import type { LibraryRepository } from './repository.js';

function refuse(code: typeof QUANT_DATABASE_URL_UNSET | typeof QUANT_DATABASE_POOL_MAX_UNSET, detail: string): LibraryRepository {
  const fail = (): never => {
    throw new QuantError(code, detail);
  };
  return {
    publish: async () => fail(),
    listing: async () => fail(),
    listingsOf: async () => fail(),
    browse: async () => fail(),
    access: async () => fail(),
    addAccess: async () => fail(),
    recordClone: async () => fail(),
    lineage: async () => fail(),
    cloneOf: async () => fail(),
    addReview: async () => fail(),
    reviews: async () => fail(),
    queue: async () => fail(),
    moderation: async () => fail(),
    moderationOf: async () => fail(),
    moderate: async () => fail(),
    openDispute: async () => fail(),
    dispute: async () => fail(),
    disputes: async () => fail(),
    resolveDispute: async () => fail(),
  };
}

/** The strategy library store. No URL means every call refuses by name. Pool size is never invented. */
export function openLibraryRepository(env: { DATABASE_URL?: string | undefined; DATABASE_POOL_MAX?: string | undefined }): {
  repository: LibraryRepository;
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
  return { repository: createPostgresLibraryRepository(sql), close: () => sql.end({ timeout: 5 }) };
}
