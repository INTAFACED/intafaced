import type postgres from 'postgres';

/**
 * Test reset for suites that apply 0023 and then clear rows.
 *
 * pay.payment_events refuses TRUNCATE, including an empty table and including
 * CASCADE from a parent. This turns that statement trigger off for one
 * transaction, runs the suite's TRUNCATE, and turns it back on before commit.
 * A rollback leaves the trigger enabled. Product code does not call this.
 */

const TRIGGER = 'payment_events_append_only_truncate_trg';
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export async function truncatePayForTest(sql: postgres.Sql, schema: string, truncateSql: string): Promise<void> {
  const [database] = await sql<Array<{ name: string }>>`SELECT current_database() AS name`;
  if (!database?.name.endsWith('_test')) throw new Error('Payment history reset requires a dedicated test database');
  if (!IDENT.test(schema)) {
    throw new Error(`refusing to reset payment events on schema ${schema}`);
  }
  const statement = truncateSql.trim();
  if (!/^truncate\b/i.test(statement) || statement.includes(';')) {
    throw new Error('payment events test reset runs one TRUNCATE statement');
  }

  const [present] = await sql<Array<{ n: string }>>`
    SELECT count(*)::text AS n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=${schema} AND c.relname='payment_events' AND t.tgname=${TRIGGER} AND NOT t.tgisinternal
  `;
  if (present?.n === '0') {
    await sql.unsafe(statement);
    return;
  }
  await sql.begin(async (tx) => {
    await tx.unsafe(`ALTER TABLE "${schema}"."payment_events" DISABLE TRIGGER "${TRIGGER}"`);
    await tx.unsafe(statement);
    await tx.unsafe(`ALTER TABLE "${schema}"."payment_events" ENABLE TRIGGER "${TRIGGER}"`);
  });

  const enabled = await sql<Array<{ tgenabled: string }>>`
    SELECT t.tgenabled
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${schema}
       AND c.relname = 'payment_events'
       AND t.tgname = ${TRIGGER}
       AND NOT t.tgisinternal
  `;
  const flag = enabled[0]?.tgenabled;
  if (flag !== 'O') {
    throw new Error(`payment events truncate trigger was left disabled after the test reset (tgenabled=${flag ?? 'missing'})`);
  }
}
