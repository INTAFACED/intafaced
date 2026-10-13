import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';

/**
 * Rollback of 0022 must finish while a membership row is still present and
 * put the 0021 allow-list back: owner and member.
 */
const URL = process.env.TEST_DATABASE_URL ?? 'postgres://Nitro@127.0.0.1:5432/intafaced_test';
const PRIOR_ROLE_CHECK = `CHECK ((role = ANY (ARRAY['owner'::text, 'member'::text])))`;

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '../../drizzle');
const through0022 = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql') && f <= '0022_org_roles.sql')
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));
const down0022 = readFileSync(join(drizzleDir, '0022_org_roles.down.sql'), 'utf8');

if (through0022.length === 0) throw new Error(`No migrations found in ${drizzleDir}`);

const db: TestDb = await createTestDb({
  service: 'identity',
  url: URL,
  migrations: through0022.map((body) => (schema: string) => rewriteSchemaSql(body, 'identity', schema)),
});

describe('org role rollback', () => {
  afterAll(async () => {
    await db.drop();
  });

  it('finishes with a membership row present and restores the owner and member allow-list', async () => {
    const handle = `l225${process.pid}`;
    const [user] = await db.sql<Array<{ id: string }>>`
      INSERT INTO users (handle, email, password_hash)
      VALUES (${handle}, ${`${handle}@example.com`}, ${'not-a-secret'})
      RETURNING id
    `;
    const [org] = await db.sql<Array<{ id: string }>>`
      INSERT INTO organizations (name, created_by)
      VALUES ('Desk', ${user!.id})
      RETURNING id
    `;
    await db.sql`
      INSERT INTO organization_members (org_id, user_id, role)
      VALUES (${org!.id}, ${user!.id}, 'admin')
    `;

    const before = await db.sql<Array<{ user_id: string; role: string }>>`
      SELECT user_id, role FROM organization_members
    `;
    expect(before).toEqual([{ user_id: user!.id, role: 'admin' }]);

    await db.sql.unsafe(rewriteSchemaSql(down0022, 'identity', db.schema));

    const after = await db.sql<Array<{ user_id: string; role: string }>>`
      SELECT user_id, role FROM organization_members
    `;
    expect(after).toEqual([{ user_id: user!.id, role: 'owner' }]);

    const [constraint] = await db.sql<Array<{ def: string }>>`
      SELECT pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE c.conname = 'organization_members_role_ck'
        AND n.nspname = ${db.schema}
        AND t.relname = 'organization_members'
    `;
    expect(constraint?.def).toBe(PRIOR_ROLE_CHECK);

    await db.sql`UPDATE organization_members SET role = 'member' WHERE user_id = ${user!.id}`;
    await db.sql`UPDATE organization_members SET role = 'owner' WHERE user_id = ${user!.id}`;

    for (const refused of ['admin', 'trader', 'auditor'] as const) {
      await expect(
        db.sql`UPDATE organization_members SET role = ${refused} WHERE user_id = ${user!.id}`,
      ).rejects.toMatchObject({ code: '23514' });
    }

    const kept = await db.sql<Array<{ user_id: string; role: string }>>`
      SELECT user_id, role FROM organization_members
    `;
    expect(kept).toEqual([{ user_id: user!.id, role: 'owner' }]);
  });
});
