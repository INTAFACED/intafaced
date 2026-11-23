import postgres from 'postgres';
import { QUANT_DATABASE_POOL_MAX_UNSET, QUANT_DATABASE_URL_UNSET, QuantError } from '../errors.js';
import type { QuotaGate } from '../quota/quota.js';
import { createPostgresTeamRepository } from './postgres-repository.js';
import type { TeamRepository } from './repository.js';

function refuse(code: typeof QUANT_DATABASE_URL_UNSET | typeof QUANT_DATABASE_POOL_MAX_UNSET, detail: string): TeamRepository {
  const fail = (): never => {
    throw new QuantError(code, detail);
  };
  return {
    collaborators: async () => fail(),
    membership: async () => fail(),
    sharedWith: async () => fail(),
    upsert: async () => fail(),
    remove: async () => fail(),
    mostCollaborators: async () => fail(),
    lock: async () => fail(),
    takeLock: async () => fail(),
    releaseLock: async () => fail(),
    grants: async () => fail(),
    createGrant: async () => fail(),
    recordRead: async () => fail(),
    reads: async () => fail(),
  };
}

/** Strategy team store. No URL means every call refuses by name. Pool size is never invented. */
export function openTeamRepository(
  env: { DATABASE_URL?: string | undefined; DATABASE_POOL_MAX?: string | undefined },
  gate?: QuotaGate,
): { repository: TeamRepository; close: () => Promise<void> } {
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
  return { repository: createPostgresTeamRepository(sql, gate), close: () => sql.end({ timeout: 5 }) };
}
