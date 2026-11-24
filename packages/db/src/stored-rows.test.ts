/**
 * `storedRows` and `rowsChange`: the rows a service's tables hold, compared after the same inputs (the wire replay's
 * rows). TEST values only.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDatabase, postgresAvailable, rowsChange, storedRows, type TestDatabase } from './testing.js';

describe('rowsChange', () => {
  it('names rows added and removed, a changed row as one of each, and counts a repeated row', () => {
    expect(rowsChange(['a 1', 'b 1', 'b 1'], ['a 2', 'b 1', 'c 1'])).toEqual({ added: ['a 2', 'c 1'], removed: ['a 1', 'b 1'] });
    expect(rowsChange(['a 1'], ['a 1'])).toEqual({ added: [], removed: [] });
  });
});

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
const live = await postgresAvailable(URL);

describe.skipIf(!live)('storedRows', () => {
  let db: TestDatabase | undefined;
  afterAll(async () => {
    await db?.drop();
  });

  it('reads every table sorted, numerics digit for digit, times in UTC, and only database-made values masked', async () => {
    db = await createTestDatabase({
      url: URL,
      service: 'rowsprobe',
      migrations: [
        `CREATE TABLE rowsprobe.b (id text PRIMARY KEY, at timestamptz NOT NULL, amount numeric(38,18) NOT NULL,
           made_at timestamptz NOT NULL DEFAULT now(), made_id uuid DEFAULT gen_random_uuid(), maybe timestamptz DEFAULT now())`,
        `CREATE TABLE rowsprobe.a (id text PRIMARY KEY)`,
      ],
    });
    await db.sql.unsafe(`SET TIME ZONE 'Asia/Makassar'`);
    await db.sql`INSERT INTO rowsprobe.a (id) VALUES ('z'), ('y')`;
    await db.sql`INSERT INTO rowsprobe.b (id, at, amount, maybe) VALUES ('k', '2026-01-01T00:00:00Z', '123456789012345678.123456789012345678', null)`;
    expect(await storedRows(db.sql, 'rowsprobe')).toEqual([
      'a {"id": "y"}',
      'a {"id": "z"}',
      'b {"at": "2026-01-01T00:00:00+00:00", "id": "k", "maybe": null, "amount": 123456789012345678.123456789012345678, "made_at": "<database>", "made_id": "<database>"}',
    ]);
  });

  it('refuses a schema name it would have to quote', async () => {
    await expect(storedRows(db!.sql, 'x"; DROP TABLE a; --')).rejects.toThrow(/unsafe schema/);
  });
});
