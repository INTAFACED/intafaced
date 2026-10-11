import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
const run = promisify(execFile);
describe('pay owned migration runner real PostgreSQL', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase({ service: 'pay' });
  });
  afterAll(async () => {
    await db.drop();
  });
  function migrate(down = false) {
    return run(
      process.execPath,
      [
        fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url)),
        fileURLToPath(new URL('../scripts/migrate.ts', import.meta.url)),
        ...(down ? ['--down'] : []),
      ],
      { env: { ...process.env, DATABASE_URL: db.url }, timeout: 30000 },
    );
  }
  it('serializes concurrent boots, journals once, reverses and reapplies the actual SQL', async () => {
    await db.sql`CREATE TABLE pay.account_control_audit(test_conflict text)`;
    await expect(migrate()).rejects.toThrow();
    expect(
      await db.sql`SELECT table_name FROM information_schema.tables WHERE table_schema='pay' AND table_name IN('merchants','__migrations')`,
    ).toHaveLength(0);
    await db.sql`DROP TABLE pay.account_control_audit`;
    await Promise.all([migrate(), migrate()]);
    expect(await db.sql`SELECT name FROM pay.__migrations WHERE name='0018_pay_founder_controls_admission.sql'`).toHaveLength(1);
    expect(
      await db.sql`SELECT table_name FROM information_schema.tables WHERE table_schema='pay' AND table_name IN('payment_admissions','payout_admissions','account_control_audit')`,
    ).toHaveLength(3);
    await migrate(true);
    expect(await db.sql`SELECT name FROM pay.__migrations`).toHaveLength(0);
    expect(
      await db.sql`SELECT table_name FROM information_schema.tables WHERE table_schema='pay' AND table_name='payment_admissions'`,
    ).toHaveLength(0);
    await migrate(true);
    await migrate();
    expect(await db.sql`SELECT name FROM pay.__migrations WHERE name='0018_pay_founder_controls_admission.sql'`).toHaveLength(1);
  }, 60000);
});
