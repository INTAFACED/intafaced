import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { TEST_POSTGRES_DATA, testPostgres } from './test-postgres.js';

/**
 * The container every test's own Postgres comes from (intafaced#9610): its data folder is memory and crash durability
 * is off, as in CI's service database. It needs Docker, as every test that starts a container does: Docker down is a
 * failed suite, not a skip.
 */
describe('testPostgres', () => {
  it('starts with its data in memory and fsync, synchronous_commit and full_page_writes off', async () => {
    const startedAt = Date.now();
    const container = await testPostgres()
      .withDatabase('intafaced_helper_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    const readyMs = Date.now() - startedAt;
    try {
      const sql = postgres(container.getConnectionUri(), { max: 1, onnotice: () => undefined });
      try {
        const rows = await sql<{ name: string; setting: string }[]>`
          SELECT name, setting FROM pg_settings
          WHERE name IN ('fsync', 'synchronous_commit', 'full_page_writes', 'data_directory') ORDER BY name`;
        expect(Object.fromEntries(rows.map((r) => [r.name, r.setting]))).toEqual({
          data_directory: TEST_POSTGRES_DATA,
          fsync: 'off',
          full_page_writes: 'off',
          synchronous_commit: 'off',
        });
      } finally {
        await sql.end();
      }
      const mount = await container.exec(['sh', '-c', `awk '$2 == "${TEST_POSTGRES_DATA}" { print $3 }' /proc/mounts`]);
      expect(mount.output.trim()).toBe('tmpfs');
      console.info(`testPostgres: start to ready ${readyMs} ms`);
    } finally {
      await container.stop();
    }
  }, 120_000);
});
