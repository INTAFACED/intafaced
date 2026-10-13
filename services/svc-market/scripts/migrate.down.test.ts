import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const serviceRoot = fileURLToPath(new URL('../', import.meta.url));
const directory = new URL('../drizzle/', import.meta.url);
const migrations = readdirSync(directory)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(new URL(name, directory), 'utf8'));
const migration = '0007_market_purchase_access_window.sql';
const url = process.env.TEST_DATABASE_URL?.trim();
if (!url) throw new Error('Market runner tests require an isolated TEST_DATABASE_URL');

async function fixture() {
  const db = await createTestDatabase({ service: 'market', url, migrations });
  try {
    await db.sql`CREATE TABLE market.__migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    // These fixtures test the recorded 0007 reversal only. Earlier schema
    // migrations were applied by the isolated harness, not claimed by this CLI.
    await db.sql`INSERT INTO market.__migrations (name) VALUES (${migration})`;
    const vendor = randomUUID(),
      seller = randomUUID(),
      listing = randomUUID(),
      purchase = randomUUID();
    await db.sql`INSERT INTO market.vendors (id, user_id, display_name, description, status) VALUES (${vendor}, ${seller}, 'Fixture', 'Runner atomicity', 'approved')`;
    await db.sql`INSERT INTO market.listings (id, vendor_id, title, description, offer_type, asset_id, price, period_seconds) VALUES (${listing}, ${vendor}, 'Feed', 'Hourly', 'subscription', 'USDT', 10, 3600)`;
    await db.sql`INSERT INTO market.purchases (id, listing_id, buyer_id, vendor_id, vendor_user_id, asset_id, price, commission_bps, period_seconds, status) VALUES (${purchase}, ${listing}, ${randomUUID()}, ${vendor}, ${seller}, 'USDT', 10, 500, NULL, 'pending')`;
    return { db, purchase };
  } catch (err) {
    await db.drop();
    throw err;
  }
}

async function run(db: TestDatabase, down = false) {
  try {
    const result = await execute('pnpm', ['exec', 'tsx', 'scripts/migrate.ts', ...(down ? ['--down'] : [])], {
      cwd: serviceRoot,
      env: { ...process.env, DATABASE_URL: db.url },
      timeout: 10_000,
    });
    return { code: 0, ...result };
  } catch (err) {
    const failure = err as { code?: number | string; stdout?: string; stderr?: string };
    return { code: failure.code, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

async function row(db: TestDatabase, purchase: string) {
  const [result] = await db.sql`SELECT to_jsonb(p) AS row FROM market.purchases p WHERE id = ${purchase}`;
  return result!.row as Record<string, unknown>;
}

// Each test shells out to the real migration runner against a fresh database; 5 s is not enough under CI load.
describe('actual market migration runner down transactions', { timeout: 30_000 }, () => {
  it('rolls back the complete reversal when its tracking-row delete fails', async () => {
    const { db, purchase } = await fixture();
    try {
      await db.sql.unsafe(
        `CREATE FUNCTION market.refuse_tracking_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture tracking delete failed'; END; $$; CREATE TRIGGER refuse_tracking_delete BEFORE DELETE ON market.__migrations FOR EACH ROW EXECUTE FUNCTION market.refuse_tracking_delete()`,
      );
      const original = await row(db, purchase);
      const result = await run(db, true);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('fixture tracking delete failed');
      expect(await row(db, purchase)).toEqual(original);
      const [tracked] = await db.sql`SELECT name FROM market.__migrations WHERE name = ${migration}`;
      expect(tracked?.name).toBe(migration);
      // The complete file's triggers/constraints also survive; its column
      // alone is insufficient proof that all DDL rolled back.
      await expect(db.sql`UPDATE market.purchases SET period_seconds = 7200 WHERE id = ${purchase}`).rejects.toMatchObject({
        code: '23514',
      });
      await expect(db.sql`UPDATE market.purchases SET access_until = now() WHERE id = ${purchase}`).rejects.toMatchObject({
        code: '23514',
      });
    } finally {
      await db.drop();
    }
  });

  it('refuses known periods without clearing terms or the applied marker', async () => {
    const { db, purchase } = await fixture();
    try {
      // Insert a genuine new known-term claim; the existing NULL snapshot is
      // immutable and cannot be populated from a current listing afterward.
      const [old] = await db.sql`SELECT * FROM market.purchases WHERE id = ${purchase}`;
      const known = randomUUID();
      await db.sql`INSERT INTO market.purchases (id, listing_id, buyer_id, vendor_id, vendor_user_id, asset_id, price, commission_bps, period_seconds, status) VALUES (${known}, ${old!.listing_id}, ${old!.buyer_id}, ${old!.vendor_id}, ${old!.vendor_user_id}, 'USDT', 10, 500, 3600, 'pending')`;
      const original = await row(db, known);
      const result = await run(db, true);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('market.purchase_period_downgrade_refused');
      expect(await row(db, known)).toEqual(original);
      expect((await db.sql`SELECT name FROM market.__migrations WHERE name = ${migration}`)[0]?.name).toBe(migration);
    } finally {
      await db.drop();
    }
  });

  it('reverses a recorded unknown-NULL period and re-upgrades without inventing a term', async () => {
    const { db, purchase } = await fixture();
    try {
      const original = await row(db, purchase);
      expect((await run(db, true)).code).toBe(0);
      const { period_seconds: _unknown, ...withoutPeriod } = original;
      expect(await row(db, purchase)).toEqual(withoutPeriod);
      expect(await db.sql`SELECT name FROM market.__migrations WHERE name = ${migration}`).toHaveLength(0);
      expect((await run(db)).code).toBe(0);
      expect(await row(db, purchase)).toEqual(original);
      expect((await db.sql`SELECT name FROM market.__migrations WHERE name = ${migration}`)[0]?.name).toBe(migration);
    } finally {
      await db.drop();
    }
  });
});
