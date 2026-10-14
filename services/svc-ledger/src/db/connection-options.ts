import type { Options, PostgresType } from 'postgres';

/**
 * THE POSTING PATH MUST FAIL FAST, NOT HANG.
 *
 * Every post in this service takes `FOR UPDATE` on the singleton `chain_tip`
 * row, and the README states the consequence plainly: "posting throughput is
 * globally serial — one transaction at a time, platform-wide." That is a
 * deliberate design, and it has one operational edge. A single query that never
 * returns holds that lock, and **every** value movement in the OS — trading,
 * payments, escrow, staking, rewards — queues behind it with no bound and no
 * error. `transaction()` retries only on serialization failure and deadlock
 * (`40001` / `40P01`), so nothing recovers on its own.
 *
 * `statement_timeout` is what turns that from an indefinite platform-wide
 * outage into a failed transaction that rolls back and releases the lock.
 *
 * This service builds its own `postgres()` rather than using `createDb`, because
 * it needs a `search_path` the helper does not set. What it inherited from that
 * choice was every default the helper applies — including this one, which
 * `packages/db/src/connection.ts` documents in as many words: "Statement timeout
 * in ms. Money paths should fail fast, not hang."
 *
 * The values are the helper's, deliberately. A ledger post is a handful of
 * statements inside one transaction and comes nowhere near fifteen seconds; the
 * point of matching is that the most money-critical service in the OS should not
 * be the one running looser limits than the shared default it skipped.
 */
export const LEDGER_STATEMENT_TIMEOUT_MS = 15_000;

/**
 * A transaction that goes quiet is ended, not waited on.
 *
 * `statement_timeout` bounds one statement. It does not bound the gap BETWEEN
 * statements: a caller that opens a transaction, takes the `chain_tip` lock
 * and then stalls holds that lock for as long as it likes. Postgres ends such a
 * session after this long and rolls the transaction back, which releases the
 * lock.
 *
 * It is also one term of the in-flight estimate for a lost-reply post. svc-bank
 * refuses to release collateral for a pending loan until 7 minutes after its
 * last attempt: a signed call is refused after SERVICE_CALL_MAX_SKEW_SECONDS
 * (300 s), plus one 15 s statement, plus this 60 s of idle time, plus the
 * caller's 25 s retry deadline. Without this setting the last term has no limit.
 *
 * It is evidence, NOT proof: it bounds each gap, not the whole posting
 * transaction, and it does not bound time an accepted request spends queued in
 * this pool (postgres.js has no acquire deadline, Fastify no request timeout).
 * A ledger without this setting (mixed deploy) lacks the term entirely. See
 * docs/runbooks/bank-recovery-ops.md and the ADR's phase 2.
 *
 * Same value as `packages/db`'s default, on purpose.
 */
export const LEDGER_IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;
export const LEDGER_CONNECT_TIMEOUT_S = 10;

export interface LedgerConnectionEnv {
  readonly DATABASE_POOL_MAX: number;
  readonly DATABASE_SSL: boolean;
  readonly SERVICE_NAME: string;
}

/** The options `index.ts` opens the pool with. Exported so the limits are checkable. */
export function ledgerPostgresOptions(env: LedgerConnectionEnv): Options<Record<string, PostgresType>> {
  return {
    max: env.DATABASE_POOL_MAX,
    ssl: env.DATABASE_SSL ? 'require' : false,
    connect_timeout: LEDGER_CONNECT_TIMEOUT_S,
    connection: {
      search_path: 'ledger,public',
      application_name: env.SERVICE_NAME,
      statement_timeout: LEDGER_STATEMENT_TIMEOUT_MS,
      idle_in_transaction_session_timeout: LEDGER_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    },
    onnotice: () => undefined,
  };
}
