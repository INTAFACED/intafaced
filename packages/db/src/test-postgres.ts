import { PostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * The one way a test starts its own Postgres container (`garden/test-postgres-helper` refuses any other
 * `new PostgreSqlContainer(`). The database is thrown away with the container, so, as CI's service database
 * does (`.github/workflows/ci.yml`, "skips crash durability"), its data lives in memory and it skips crash
 * durability. On disk with full durability a container took 9-257 s from start to ready on a loaded machine,
 * against 4-8 s like this (intafaced#9610).
 *
 * Chain `.withDatabase()`, `.withUsername()`, `.withPassword()` and `.start()` on it as on the container itself.
 */
export const TEST_POSTGRES_DATA = '/var/lib/postgresql/data';
export const TEST_POSTGRES_FLAGS = ['fsync=off', 'synchronous_commit=off', 'full_page_writes=off'] as const;

export function testPostgres(image = 'postgres:16-alpine'): PostgreSqlContainer {
  return new PostgreSqlContainer(image)
    .withTmpFs({ [TEST_POSTGRES_DATA]: 'rw' })
    .withCommand(['postgres', ...TEST_POSTGRES_FLAGS.flatMap((flag) => ['-c', flag])]);
}
