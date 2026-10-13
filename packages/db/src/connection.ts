import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';

/**
 * Database connections.
 *
 * One rule, enforced by the dev database's per-service roles (see
 * tooling/infra/postgres-init): a service connects with its own role and can
 * only see its own schema. §2 — "services never import each other's DB
 * schemas" — is not a convention here, it is a grant.
 */

export interface DbOptions {
  url: string;
  /** The service's Postgres schema, e.g. 'ledger'. Sets search_path. */
  schema: string;
  /**
   * Owner-published pool size. Required. Unset refuses (never invent 10).
   * postgres.js defaults max to 10 when omitted — refuse before that library
   * republishes it. 0 is not a legal pool. Owner may set 10 explicitly.
   */
  max: number;
  ssl?: boolean;
  /** Statement timeout in ms. Money paths should fail fast, not hang. */
  statementTimeoutMs?: number;
  /**
   * How long a session may sit idle INSIDE an open transaction before Postgres ends it (ms; 0 disables).
   *
   * Names the failure it prevents: a transaction that holds a pooled connection while it waits on something
   * else (an HTTP call, or another query that needs a second connection from the same pool) never finishes,
   * pins its row locks, and starves the pool until the whole service stops answering. With a bound the
   * session is killed, the lock is released and the caller sees an error instead of a hang. The default is a
   * safety bound, not a product number: it is longer than any bounded outbound call made inside a
   * transaction (the shared ledger client's timeout and retries stay under it).
   */
  idleInTransactionTimeoutMs?: number;
  onNotice?: (notice: unknown) => void;
}

export interface Db<TSchema extends Record<string, unknown> = Record<string, never>> {
  readonly drizzle: PostgresJsDatabase<TSchema>;
  readonly sql: Sql;
  close(): Promise<void>;
}

export function createDb<TSchema extends Record<string, unknown>>(options: DbOptions, schema: TSchema): Db<TSchema> {
  const sql = postgres(options.url, {
    max: publishedPoolMax(options.max),
    ssl: options.ssl ? 'require' : false,
    // Every connection lands in the service's own schema, and money paths fail
    // fast rather than hanging a pool connection.
    connection: {
      search_path: `${options.schema},public`,
      application_name: options.schema,
      statement_timeout: options.statementTimeoutMs ?? 15_000,
      idle_in_transaction_session_timeout: options.idleInTransactionTimeoutMs ?? 60_000,
    },
    connect_timeout: 10,
    onnotice: options.onNotice ?? (() => undefined),
  });

  return {
    drizzle: drizzle(sql, { schema }),
    sql,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}

export type Isolation = 'serializable' | 'repeatable read' | 'read committed';

export interface TransactionOptions {
  isolation?: Isolation;
  maxAttempts?: number;
}

/**
 * Run `fn` in a transaction, retrying on serialization failures and deadlocks.
 *
 * The isolation level is a real decision, so it is explicit rather than assumed:
 *
 *   · `serializable` (default) — correct whenever correctness depends on
 *     Postgres detecting conflicts between transactions that read and write
 *     overlapping rows. Costs aborts under contention.
 *
 *   · `read committed` — correct when the caller has ALREADY established a
 *     total order by taking an exclusive lock (`SELECT … FOR UPDATE` on a
 *     singleton row) before reading anything it will later write. Transactions
 *     then queue on that lock instead of aborting one another, which under
 *     heavy contention is the difference between throughput and a retry storm.
 *     Choosing this requires the lock; without one it is simply wrong.
 *
 * The retry loop lives here so it is not re-invented per caller, and is
 * jittered so retries do not march in lockstep back into the same conflict.
 */
export async function transaction<T>(sql: Sql, fn: (tx: Sql) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
  const isolation = options.isolation ?? 'serializable';
  const maxAttempts = options.maxAttempts ?? 5;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return (await sql.begin(`isolation level ${isolation}`, (tx) => fn(tx as unknown as Sql))) as T;
    } catch (err) {
      lastError = err;
      if (!isSerializationFailure(err) || attempt === maxAttempts) throw err;
      // Full jitter backoff — retrying in lockstep just recreates the conflict.
      await sleep(Math.random() * 2 ** attempt * 5);
    }
  }

  throw lastError;
}

/** §4.2: "Enforced in one serializable transaction." */
export async function serializable<T>(sql: Sql, fn: (tx: Sql) => Promise<T>, maxAttempts = 5): Promise<T> {
  return transaction(sql, fn, { isolation: 'serializable', maxAttempts });
}

export function isSerializationFailure(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === '40001' || code === '40P01'; // serialization_failure | deadlock_detected
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Unset pool size refuses. Never invent 10. 0 is not a legal pool. */
function publishedPoolMax(value: number | undefined | null): number {
  if (value === undefined || value === null) {
    throw new Error('createDb max is unset — refuse to invent 10');
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error('createDb max is not a legal pool — refuse to invent 10');
  }
  return value;
}
