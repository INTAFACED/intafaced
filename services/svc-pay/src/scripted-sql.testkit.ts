/**
 * A stand-in for the `postgres` client that records every query and answers each from a script, for unit tests that
 * check what a service asks the database (the page size it sends, the refusal it gives before asking) without one.
 *
 * `answer(call)` returns the rows for a query, matched on its text; unmatched queries answer no rows. A transaction
 * (`begin`, `savepoint`) runs its body on the same stand-in. Helper calls (`sql(value)`, `sql.json`) return the value.
 */
export interface SqlCall {
  /** The query's text, with each interpolated value shown as `$?`. */
  readonly text: string;
  readonly values: readonly unknown[];
}

export interface ScriptedSql<S> {
  readonly sql: S;
  readonly calls: SqlCall[];
}

// The caller names the client type it hands the stand-in to (`scriptedSql<Sql>`); nothing checks the stand-in against
// it, which is why every query it is sent is recorded in `calls` for the test to read.
export function scriptedSql<S = never>(answer?: (call: SqlCall) => readonly unknown[] | undefined): ScriptedSql<S>;
export function scriptedSql(answer: (call: SqlCall) => readonly unknown[] | undefined = () => []): ScriptedSql<unknown> {
  const calls: SqlCall[] = [];
  const run = (call: SqlCall): Promise<unknown[]> => {
    calls.push(call);
    return Promise.resolve([...(answer(call) ?? [])]);
  };
  const tag = (first: unknown, ...rest: unknown[]): unknown =>
    Array.isArray(first) && Object.prototype.hasOwnProperty.call(first, 'raw') ? run({ text: first.join('$?'), values: rest }) : first;
  const onSame = async (a: unknown, b?: unknown): Promise<unknown> => {
    const body = typeof a === 'function' ? a : b;
    if (typeof body !== 'function') throw new TypeError('scriptedSql: a transaction needs a body');
    return body(fake);
  };
  const fake = Object.assign(tag, {
    begin: onSame,
    savepoint: onSame,
    unsafe: (text: string, values: unknown[] = []) => run({ text, values }),
    json: (value: unknown) => value,
    array: (value: unknown) => value,
  });
  return { sql: fake, calls };
}
