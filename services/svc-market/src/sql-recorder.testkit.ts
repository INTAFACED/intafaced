import { partial } from '@intafaced/service-kit/testing';
import type { Sql } from 'postgres';

/** One statement the service sent: its text with each bound value shown as `$n`, and the values themselves. */
export interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

/**
 * A stand-in for the `postgres` tag that records every statement the service sends and answers each with
 * `answer(query)`. Tests assert on what the service asked the database, not on its source text.
 */
export function recordingSql(answer: (query: RecordedQuery) => unknown[] | Promise<unknown[]> = () => []): {
  sql: Sql;
  queries: RecordedQuery[];
} {
  const queries: RecordedQuery[] = [];
  const tag = (strings: unknown, ...values: unknown[]) => {
    if (!Array.isArray(strings) || !('raw' in strings)) {
      // sql(value) helper form (identifiers, row lists): hand the value back as a fragment.
      return { helper: strings, values };
    }
    const parts: readonly string[] = strings;
    const text = parts
      .reduce((out, part, i) => (i === 0 ? part : `${out}$${i}${part}`), '')
      .replace(/\s+/g, ' ')
      .trim();
    const query = { text, values };
    queries.push(query);
    return Promise.resolve().then(() => answer(query));
  };
  // The other helpers the services call on the handle, served beside the tag itself.
  const helpers: Record<string, unknown> = {
    json: (value: unknown) => value,
    begin: async (mode: unknown, fn?: (tx: unknown) => unknown) => (typeof mode === 'function' ? mode(sql) : fn?.(sql)),
    unsafe: (text: string) => ({ unsafe: text }),
  };
  const handle = Object.assign(tag, { end: async (_options?: { timeout?: number | undefined }): Promise<void> => undefined });
  const sql = partial<Sql>(
    new Proxy(handle, { get: (target, key) => (typeof key === 'string' && key in helpers ? helpers[key] : Reflect.get(target, key)) }),
  );
  return { sql, queries };
}
