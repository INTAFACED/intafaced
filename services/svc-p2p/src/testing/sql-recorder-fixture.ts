import type { Sql } from 'postgres';

/**
 * Shared by the page-size tests: a stand-in for the `postgres` client that answers every query with no rows and records
 * what each one asked, so a test can call a service method and read back the page size its query carried (or that it
 * asked nothing at all). No database; the real queries are proved against Postgres in the service suites.
 */
export type SqlCall = { strings: readonly string[]; values: unknown[] };

export function recordingSql(): { sql: Sql; calls: SqlCall[] } {
  const calls: SqlCall[] = [];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ strings: [...strings], values });
    return Promise.resolve([]);
  };
  const sql = Object.assign(tag, {
    json: (value: unknown) => value,
    begin: async (fn: (tx: unknown) => unknown) => fn(sql),
  });
  // The tag, json and begin are all a service method calls on its client; the rest of Sql is never reached.
  return { sql: sql as Sql, calls };
}

/** The values each query bound right after a `LIMIT`, in the order the queries ran. */
export function limitsOf(calls: SqlCall[]): unknown[] {
  return calls.flatMap((call) => call.values.filter((_, i) => /\bLIMIT\s*$/i.test(call.strings[i] ?? '')));
}
