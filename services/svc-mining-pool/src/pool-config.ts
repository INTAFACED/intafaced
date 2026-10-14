import { loadEnv, postgresEnvSchema } from '@intafaced/config';

export interface MiningPoolDatabase {
  url: string;
  max: number;
  ssl: boolean;
}

/**
 * Database settings through the shared loader. No DATABASE_URL means no
 * database (the pool stays honest in /health, as before). A DATABASE_URL
 * without an owner-published DATABASE_POOL_MAX refuses: never invent a size.
 */
export function loadMiningPoolDatabase(source: Record<string, unknown> = process.env): MiningPoolDatabase | null {
  const raw = source.DATABASE_URL;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const env = loadEnv(postgresEnvSchema, { ...source, DATABASE_URL: raw.trim() });
  return { url: env.DATABASE_URL, max: env.DATABASE_POOL_MAX, ssl: env.DATABASE_SSL };
}
