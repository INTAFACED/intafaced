import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';

/**
 * A database that holds a KYB upload rule above the transport cap (a stack seeded
 * with 1 MiB) cannot take CHECK (max_bytes <= 716800). The pre-cap migration
 * unpublishes such a rule first; the cap then holds for every rule after.
 */
const run = promisify(execFile);
const PRE_CAP = '20261117184553_pay_kyb_upload_rules_unpublish_over_transport.sql';
const CAP = '20261117184554_pay_kyb_upload_rules_fit_transport.sql';
const CAP_BYTES = 700 * 1024;

describe('KYB upload cap migration on a database seeded before it (real PostgreSQL)', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase({ service: 'pay' });
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  function migrate() {
    return run(
      process.execPath,
      [
        fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url)),
        fileURLToPath(new URL('../scripts/migrate.ts', import.meta.url)),
      ],
      { env: { ...process.env, DATABASE_URL: db.url }, timeout: 30_000 },
    );
  }

  /** Puts the database where a stack seeded without the cap is: every older migration run, a 1 MiB rule published. */
  async function seededBeforeTheCap() {
    await db.sql`ALTER TABLE pay.kyb_upload_rules DROP CONSTRAINT IF EXISTS kyb_upload_rules_max_bytes_fits_transport`;
    await db.sql`DELETE FROM pay.__migrations WHERE name IN (${PRE_CAP}, ${CAP})`;
    await db.sql`DELETE FROM pay.kyb_upload_rules`;
    await db.sql`INSERT INTO pay.kyb_upload_rules (max_bytes, content_types) VALUES (${1024 * 1024}, ${['application/pdf']})`;
  }

  async function rules() {
    return db.sql<Array<{ max_bytes: number }>>`SELECT max_bytes FROM pay.kyb_upload_rules`;
  }

  it('without the pre-cap step the cap refuses the old row, which is the failure the stacks hit', async () => {
    await migrate();
    await seededBeforeTheCap();
    await db.sql`INSERT INTO pay.__migrations (name) VALUES (${PRE_CAP})`;
    await expect(migrate()).rejects.toThrow(/kyb_upload_rules_max_bytes_fits_transport.*violated by some row/s);
    expect(await db.sql`SELECT name FROM pay.__migrations WHERE name = ${CAP}`).toHaveLength(0);
  }, 90_000);

  it('unpublishes the over-cap rule, applies the cap, and the cap refuses every rule published above it afterwards', async () => {
    await seededBeforeTheCap();
    await migrate();
    expect(await rules()).toEqual([]);
    expect(await db.sql`SELECT name FROM pay.__migrations WHERE name IN (${PRE_CAP}, ${CAP}) ORDER BY name`).toEqual([
      { name: PRE_CAP },
      { name: CAP },
    ]);
    await expect(
      db.sql`INSERT INTO pay.kyb_upload_rules (max_bytes, content_types) VALUES (${CAP_BYTES + 1}, ${['application/pdf']})`,
    ).rejects.toThrow(/kyb_upload_rules_max_bytes_fits_transport/);
    await db.sql`INSERT INTO pay.kyb_upload_rules (max_bytes, content_types) VALUES (${CAP_BYTES}, ${['application/pdf']})`;
    expect(await rules()).toEqual([{ max_bytes: CAP_BYTES }]);
  }, 90_000);

  it('on a database that already ran the cap, the pre-cap step runs after it and leaves a rule within the cap alone', async () => {
    await db.sql`DELETE FROM pay.__migrations WHERE name = ${PRE_CAP}`;
    await migrate();
    expect(await rules()).toEqual([{ max_bytes: CAP_BYTES }]);
    expect(await db.sql`SELECT name FROM pay.__migrations WHERE name = ${PRE_CAP}`).toHaveLength(1);
  }, 90_000);
});
