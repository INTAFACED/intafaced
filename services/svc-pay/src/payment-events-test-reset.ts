import type postgres from 'postgres';

/**
 * Test reset for suites that apply migrations and then clear rows.
 *
 * pay.payment_events and pay.fraud_review_decisions refuse TRUNCATE, including
 * an empty table and including a multi-table TRUNCATE. This turns those
 * statement triggers off for one transaction, runs the suite's TRUNCATE, and
 * turns them back on before commit. A rollback leaves each trigger enabled.
 * Product code does not call this.
 */

const TRUNCATE_TRIGGERS = [
  { table: 'payment_events', trigger: 'payment_events_append_only_truncate_trg' },
  { table: 'fraud_review_decisions', trigger: 'fraud_review_decisions_append_only_truncate_trg' },
] as const;

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

  const present = await sql<Array<{ table_name: string; trigger_name: string }>>`
    SELECT c.relname AS table_name, t.tgname AS trigger_name
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${schema}
       AND NOT t.tgisinternal
       AND (
         (c.relname = 'payment_events' AND t.tgname = 'payment_events_append_only_truncate_trg')
         OR (c.relname = 'fraud_review_decisions' AND t.tgname = 'fraud_review_decisions_append_only_truncate_trg')
       )
  `;
  const triggers = TRUNCATE_TRIGGERS.filter((known) =>
    present.some((row) => row.table_name === known.table && row.trigger_name === known.trigger),
  );
  if (triggers.length === 0) {
    await sql.unsafe(statement);
    return;
  }
  await sql.begin(async (tx) => {
    for (const item of triggers) {
      await tx.unsafe(`ALTER TABLE "${schema}"."${item.table}" DISABLE TRIGGER "${item.trigger}"`);
    }
    await tx.unsafe(statement);
    for (const item of triggers) {
      await tx.unsafe(`ALTER TABLE "${schema}"."${item.table}" ENABLE TRIGGER "${item.trigger}"`);
    }
  });

  const enabled = await sql<Array<{ table_name: string; trigger_name: string; tgenabled: string }>>`
    SELECT c.relname AS table_name, t.tgname AS trigger_name, t.tgenabled
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${schema}
       AND NOT t.tgisinternal
       AND (
         (c.relname = 'payment_events' AND t.tgname = 'payment_events_append_only_truncate_trg')
         OR (c.relname = 'fraud_review_decisions' AND t.tgname = 'fraud_review_decisions_append_only_truncate_trg')
       )
  `;
  for (const item of triggers) {
    const flag = enabled.find((row) => row.table_name === item.table && row.trigger_name === item.trigger)?.tgenabled;
    if (flag !== 'O') {
      throw new Error(`${item.table} truncate trigger was left disabled after the test reset (tgenabled=${flag ?? 'missing'})`);
    }
  }
}
