import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { testPostgres } from '@intafaced/db/test-postgres';

/**
 * What svc-pay's real entry (`index.ts`) boots with in a test: a migrated throwaway database and the settings a test
 * stack gives it. The ledger, identity and the bus are dead addresses, as on a stack where they have not come up yet.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const DRIZZLE = join(HERE, '..', 'drizzle');

export const BOOT_SECRET = 'p'.repeat(48);
export const BOOT_INTERNAL_SECRET = 'i'.repeat(48);

const migrations = (): string[] =>
  readdirSync(DRIZZLE)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort()
    .map((f) => readFileSync(join(DRIZZLE, f), 'utf8'));

export interface BootDatabase {
  readonly db: TestDatabase;
  stop(): Promise<void>;
}

/** A migrated pay database: `TEST_DATABASE_URL` when set (CI), else a throwaway container. */
export async function bootDatabase(): Promise<BootDatabase> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  let stopContainer = async (): Promise<void> => {};
  let url = envUrl;
  if (!url) {
    const container = await testPostgres('postgres:16-alpine')
      .withDatabase('intafaced_pay_boot_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    url = container.getConnectionUri();
    stopContainer = async () => {
      await container.stop();
    };
  }
  const db = await createTestDatabase({ service: 'pay', url, migrations: migrations() });
  return {
    db,
    stop: async () => {
      await db.drop().catch(() => undefined);
      await stopContainer();
    },
  };
}

/** The settings a test stack boots svc-pay with; `extra` overrides one, `undefined` removes it. */
export function bootEnv(databaseUrl: string, port: number, extra: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    APP_ENV: 'test',
    SERVICE_NAME: 'svc-pay',
    HTTP_HOST: '127.0.0.1',
    HTTP_PORT: String(port),
    LOG_LEVEL: 'info',
    OTEL_ENABLED: 'false',
    DATABASE_URL: databaseUrl,
    DATABASE_POOL_MAX: '4',
    EDGE_PRINCIPAL_SECRET: BOOT_SECRET,
    INTERNAL_SERVICE_SECRET: BOOT_INTERNAL_SECRET,
    PAY_CRYPTO_WEBHOOK_SECRET: BOOT_SECRET,
    PAY_CARD_SANDBOX_WEBHOOK_SECRET: 'c'.repeat(48),
    PAY_MIN_CONFIRMATIONS: '6',
    PAY_WEBHOOK_TOLERANCE_SECONDS: '300',
    PAY_OPERATOR_CREDIT_RAILS: 'card-sandbox',
    PAY_CHECKOUT_SESSION_TTL_SECONDS: '900',
    PAY_LINK_DEFAULT_TTL_DAYS: '30',
    PAY_LINK_MAX_TTL_DAYS: '365',
    PAY_CHECKOUT_MAX_OPEN_SESSIONS: '25',
    INTAFACED_SCREENING_FAIL_CLOSED: 'off',
    LEDGER_URL: 'http://127.0.0.1:1',
  };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}
