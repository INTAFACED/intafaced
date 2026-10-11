import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, '..', 'drizzle');
const oldNames = readdirSync(dir)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql') && name < '0020')
  .sort();
async function migrate(url: string, down = false) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn('pnpm', ['exec', 'tsx', 'scripts/migrate.ts', ...(down ? ['--down'] : [])], {
      cwd: join(here, '..'),
      env: { ...process.env, DATABASE_URL: url },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (value) => (output += value));
    child.stderr?.on('data', (value) => (output += value));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}
describe('payment recovery preserves populated public schema through actual migration runner', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error('Native recovery proof requires an explicitly owned test database');
    db = await createTestDatabase({ service: 'pay', url, migrations: oldNames.map((name) => readFileSync(join(dir, name), 'utf8')) });
    await db.sql`CREATE TABLE pay.__migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    for (const name of oldNames) await db.sql`INSERT INTO pay.__migrations(name) VALUES (${name})`;
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  }, 30_000);
  it('keeps original amount, permission/history and unknown legacy dispatch; guarded down rolls back its tracking transaction', async () => {
    const [merchant] =
      await db.sql`INSERT INTO pay.merchants(user_id,pricing,status) VALUES ('native-upgrade-owner','{"feeBps":250}','active') RETURNING id`;
    const [payment] =
      await db.sql`INSERT INTO pay.payments(merchant_id,amount,currency,method,rail_adapter) VALUES (${merchant!.id},'40','USDT','card','card-sandbox') RETURNING id`;
    await db.sql`INSERT INTO pay.payment_events(payment_id,event,payload) VALUES (${payment!.id},'created','{"amount":"40"}')`;
    const [withdrawal] =
      await db.sql`INSERT INTO pay.withdrawals(user_id,asset_id,amount,rail,destination,client_ref,status) VALUES ('native-upgrade-owner','USDT','40','card-sandbox','{"kind":"bank","ref":"DE89370400440532013000"}','known-original-key','held') RETURNING id`;
    const up = await migrate(db.url);
    expect(up.output).not.toContain('ERROR');
    expect(up.code, up.output).toBe(0);
    const [original] = await db.sql`SELECT amount::text,currency,rail_adapter FROM pay.payments WHERE id=${payment!.id}`;
    expect(original).toMatchObject({ amount: '40.000000000000000000', currency: 'USDT', rail_adapter: 'card-sandbox' });
    expect(await db.sql`SELECT * FROM pay.withdrawal_rail_attempts`).toHaveLength(0);
    expect(await db.sql`SELECT client_ref,status FROM pay.withdrawals WHERE id=${withdrawal!.id}`).toMatchObject([
      { client_ref: 'known-original-key', status: 'held' },
    ]);
    await expect(db.sql`UPDATE pay.payments SET amount='41' WHERE id=${payment!.id}`).rejects.toMatchObject({ code: '23001' });
    const before = await db.sql`SELECT name FROM pay.__migrations ORDER BY name`;
    const down = await migrate(db.url, true);
    expect(down.code).not.toBe(0);
    expect(down.output).toContain('history prevents downgrade');
    expect(await db.sql`SELECT name FROM pay.__migrations ORDER BY name`).toEqual(before);
    expect(await db.sql`SELECT event FROM pay.payment_events WHERE payment_id=${payment!.id}`).toMatchObject([{ event: 'created' }]);
    expect((await migrate(db.url)).code).toBe(0);
  }, 30_000);
  it('serializes opposite parent changes before either can create a cycle', async () => {
    const rows = await db.sql`INSERT INTO pay.merchants(user_id) VALUES ('native-parent-a'),('native-parent-b') RETURNING id`;
    const one = postgres(db.url, { max: 1, onnotice: () => undefined });
    const two = postgres(db.url, { max: 1, onnotice: () => undefined });
    try {
      const [backend] = await two`SELECT pg_backend_pid() AS pid`;
      await one`BEGIN`;
      await one`UPDATE pay.merchants SET parent_merchant_id=${rows[1]!.id} WHERE id=${rows[0]!.id}`;
      const competing = two`UPDATE pay.merchants SET parent_merchant_id=${rows[0]!.id} WHERE id=${rows[1]!.id}`.then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      let blocked = false;
      for (let tries = 0; tries < 100; tries++) {
        const [state] = await db.sql`SELECT cardinality(pg_blocking_pids(${backend!.pid})) AS count`;
        if (Number(state?.count) > 0) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await one`COMMIT`;
      const result = await competing;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatchObject({ code: '23514' });
      const parents = await db.sql`SELECT id,parent_merchant_id FROM pay.merchants WHERE id IN (${rows[0]!.id},${rows[1]!.id})`;
      expect(parents.filter((row) => row.parent_merchant_id !== null)).toHaveLength(1);
    } finally {
      await one`ROLLBACK`;
      await one.end();
      await two.end();
    }
  }, 10_000);
});
