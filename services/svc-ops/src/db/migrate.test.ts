import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { createTestDatabase } from '@intafaced/db';
import { describe, expect, it } from 'vitest';
import { migrateOutreach } from './migrate.js';

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('OPS migration schema ownership on real PostgreSQL', () => {
  it('migrates a preprovisioned owned schema without database CREATE privilege', async () => {
    const database = await createTestDatabase({ service: 'ops' });
    const owner = postgres(process.env.TEST_DATABASE_URL!, { max: 1, onnotice: () => undefined });
    const role = `crm_migration_${randomUUID().replaceAll('-', '')}`;
    const password = randomBytes(32).toString('base64url');
    let service: ReturnType<typeof postgres> | undefined;
    let created = false;
    try {
      await owner.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
      created = true;
      await database.sql.unsafe(`ALTER SCHEMA ops OWNER TO ${role}`);
      const connection = new URL(database.url);
      await database.sql`GRANT CONNECT ON DATABASE ${database.sql(connection.pathname.slice(1))} TO ${database.sql(role)}`;
      connection.username = role;
      connection.password = password;
      service = postgres(connection.href, { max: 1, onnotice: () => undefined });
      const [privileges] = await service`SELECT has_database_privilege(current_user,current_database(),'CREATE') AS database_create,
        has_schema_privilege(current_user,'ops','CREATE') AS schema_create`;
      expect(privileges).toMatchObject({ database_create: false, schema_create: true });
      await migrateOutreach(service);
      await migrateOutreach(service);
      expect(await service`SELECT name FROM ops.crm_migrations`).toHaveLength(24);
      expect(await service`SELECT id FROM ops.crm_erasure_intents`).toHaveLength(0);
    } finally {
      await service?.end();
      await database.drop();
      if (created) await owner.unsafe(`DROP ROLE ${role}`);
      await owner.end();
    }
  });
});
