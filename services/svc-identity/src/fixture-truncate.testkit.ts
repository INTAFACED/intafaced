import {
  createTestDatabase as createRunDatabase,
  createTestDb as createSchemaTestDb,
  type TestDatabase,
  type TestDatabaseOptions,
  type TestDb,
  type TestDbOptions,
} from '@intafaced/db';

/**
 * Shared fixture reset for svc-identity Postgres tests.
 *
 * Excluded from the production build (tsconfig.json), included in the test
 * typecheck. Every identity suite that resets rows goes through `createTestDb`
 * or `createTestDatabase` here, so `truncateAll` retries a fixture deadlock.
 * Product statements are not retried.
 */

/** One try plus three retries. A stuck cycle still fails the test. */
export const FIXTURE_TRUNCATE_ATTEMPTS = 4;

function postgresCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Fixture TRUNCATE only. A reset can deadlock with an insert the previous case
 * did not wait for (40P01). Postgres aborts one side; retrying the truncate is
 * safe. No other error, including serialization failure, is retried.
 */
export async function retryFixtureTruncate(run: () => Promise<void>): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await run();
      return;
    } catch (err) {
      if (postgresCode(err) !== '40P01' || attempt >= FIXTURE_TRUNCATE_ATTEMPTS) throw err;
    }
  }
}

function withFixtureTruncateRetry<T extends { truncateAll(): Promise<void> }>(db: T): T {
  const truncateAll = db.truncateAll.bind(db);
  return Object.assign(db, {
    truncateAll: () => retryFixtureTruncate(truncateAll),
  });
}

export async function createTestDb(options: TestDbOptions): Promise<TestDb> {
  return withFixtureTruncateRetry(await createSchemaTestDb(options));
}

export async function createTestDatabase(options: TestDatabaseOptions): Promise<TestDatabase> {
  return withFixtureTruncateRetry(await createRunDatabase(options));
}
