import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPendingUp } from './migrate.js';

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://Nitro@127.0.0.1:5432/intafaced_test';

describe('academy up migrations', () => {
  const schemas: string[] = [];
  const dirs: string[] = [];
  const clients: postgres.Sql[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      await client.end({ timeout: 5 });
    }
    const admin = postgres(URL, { max: 1, onnotice: () => undefined });
    try {
      for (const schema of schemas.splice(0)) {
        await admin`DROP SCHEMA IF EXISTS ${admin(schema)} CASCADE`;
      }
    } finally {
      await admin.end({ timeout: 5 });
    }
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies a pending file once, in the same transaction that records it', async () => {
    const admin = postgres(URL, { max: 1, onnotice: () => undefined });
    clients.push(admin);
    const database = await admin<{ name: string }[]>`SELECT current_database() AS name`;
    const name = database[0]?.name;
    if (name === undefined || !name.endsWith('_test')) {
      throw new Error(`refusing to migrate against database ${name ?? '(none)'}`);
    }

    const schema = `l127_${process.pid}_${randomBytes(4).toString('hex')}`;
    schemas.push(schema);
    await admin`CREATE SCHEMA ${admin(schema)}`;

    const dir = mkdtempSync(join(tmpdir(), 'l127-academy-'));
    dirs.push(dir);
    const once = '0001_once.sql';
    writeFileSync(
      join(dir, once),
      `CREATE TABLE IF NOT EXISTS ${schema}.runs (n int NOT NULL);\nINSERT INTO ${schema}.runs (n) VALUES (1);\nSELECT pg_sleep(0.8);\n`,
    );

    const runnerA = postgres(URL, { max: 1, onnotice: () => undefined });
    const runnerB = postgres(URL, { max: 1, onnotice: () => undefined });
    clients.push(runnerA, runnerB);

    const raced = await Promise.allSettled([applyPendingUp(runnerA, dir, schema), applyPendingUp(runnerB, dir, schema)]);
    expect(raced.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);

    const runs = await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM ${admin(schema)}.runs`;
    expect(Number(runs[0]?.n)).toBe(1);
    const recorded = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${admin(schema)}.__migrations WHERE name = ${once}
    `;
    expect(Number(recorded[0]?.n)).toBe(1);

    await admin.unsafe(`
      CREATE FUNCTION ${schema}.refuse_record() RETURNS trigger
      LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.name = '0002_refuse.sql' THEN
          RAISE EXCEPTION 'refuse migration record';
        END IF;
        RETURN NEW;
      END
      $fn$;
      CREATE TRIGGER refuse_record
      BEFORE INSERT ON ${schema}.__migrations
      FOR EACH ROW EXECUTE FUNCTION ${schema}.refuse_record();
    `);
    writeFileSync(join(dir, '0002_refuse.sql'), `INSERT INTO ${schema}.runs (n) VALUES (2);\n`);

    await expect(applyPendingUp(runnerA, dir, schema)).rejects.toThrow(/refuse migration record/);

    const afterRefuse = await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM ${admin(schema)}.runs`;
    expect(Number(afterRefuse[0]?.n)).toBe(1);
    const refused = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${admin(schema)}.__migrations WHERE name = ${'0002_refuse.sql'}
    `;
    expect(Number(refused[0]?.n)).toBe(0);
  });
});
