/**
 * One type for "a connection or a transaction" (project-state#2760).
 *
 * `transaction()` used to hand its callback a transaction cast to `Sql`, so every helper typed `Sql` accepted it, the
 * compiler stopped checking those calls, and services copied the cast (`tx as unknown as Sql`) over a hundred times.
 * Now the callback gets the `TransactionSql` it really is; a helper that runs on either takes `Queryable`. This file is
 * type-checked with the package (`typecheck` runs tooling/ci/test-typecheck.mjs): on the old signature the
 * `@ts-expect-error` lines below have no error to expect, and the check fails.
 */
import postgres, { type Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { requireConnection, transaction, type Queryable } from './connection.js';
import { postgresAvailable } from './testing.js';

/** Never run: the compiler is the test. */
export function typesOnly(sql: Sql): Promise<number> {
  return transaction(sql, async (tx) => {
    const handle: Queryable = tx;
    await tx.savepoint(async (sp) => sp`SELECT 1`);
    // @ts-expect-error a transaction cannot begin another; the old `Sql`-typed callback allowed this and threw at run time
    await tx.begin(async () => 1);
    // @ts-expect-error a transaction is not a connection, so a helper typed `Sql` refuses it: type that helper `Queryable`
    const connection: Sql = tx;
    void connection;
    return (await handle`SELECT 1 AS n`).length;
  });
}

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://intafaced_ops:intafaced_ops@localhost:5433/intafaced_test';
/** Resolved once, at module scope: `describe` callbacks are synchronous. */
const live = await postgresAvailable(URL);

describe('requireConnection', () => {
  it('returns a connection, which can begin', async () => {
    // postgres.js connects on the first query, so an unreachable address is a real handle that never dials.
    const sql = postgres('postgres://u:p@127.0.0.1:1/db', { max: 1 });
    try {
      expect(requireConnection(sql)).toBe(sql);
    } finally {
      await sql.end({ timeout: 1 });
    }
  });

  it.skipIf(!live)('refuses a real transaction by name: it has no begin, which the old cast to Sql hid', async () => {
    const sql = postgres(URL, { max: 1, onnotice: () => undefined });
    try {
      await transaction(sql, async (tx) => {
        expect('begin' in tx).toBe(false);
        expect(() => requireConnection(tx)).toThrow(/a transaction cannot begin another; use savepoint/);
      });
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});
