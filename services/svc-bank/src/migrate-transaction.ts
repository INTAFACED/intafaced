import type { Sql } from 'postgres';

/**
 * The file body and the bank.__migrations write share one transaction.
 * If the bookkeeping write fails, Postgres rolls the body back with it.
 */
export async function applyMigrationUp(sql: Sql, name: string, body: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe(body);
    await tx`INSERT INTO bank.__migrations (name) VALUES (${name})`;
  });
}

/** Same boundary as up: the down body and the delete of that name. */
export async function applyMigrationDown(sql: Sql, name: string, body: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe(body);
    await tx`DELETE FROM bank.__migrations WHERE name = ${name}`;
  });
}

/**
 * Latest filename first, and only names already recorded in bank.__migrations.
 * A sibling .sql that was never applied is not reversed.
 */
export function reversalNames(upFiles: readonly string[], appliedNames: ReadonlySet<string>): string[] {
  return [...upFiles].reverse().filter((name) => appliedNames.has(name));
}
