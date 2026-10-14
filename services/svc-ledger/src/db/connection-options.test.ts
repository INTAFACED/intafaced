import { describe, expect, it } from 'vitest';
import {
  LEDGER_CONNECT_TIMEOUT_S,
  LEDGER_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  LEDGER_STATEMENT_TIMEOUT_MS,
  ledgerPostgresOptions,
} from './connection-options.js';

/**
 * The limits are the point, so the limits are asserted.
 *
 * This service opens its own pool rather than using `createDb`, and in doing so
 * inherited none of that helper's defaults — including the statement timeout it
 * documents as "money paths should fail fast, not hang". Without it, one wedged
 * query holds the `chain_tip` lock and every value movement in the OS queues
 * behind it indefinitely.
 *
 * A setting that lives inline in `index.ts` cannot be tested without booting the
 * service, which is why it went unnoticed. It lives in its own module now for
 * exactly one reason: so a future edit that drops it fails here.
 */

const ENV = { DATABASE_POOL_MAX: 10, DATABASE_SSL: false, SERVICE_NAME: 'svc-ledger' };

describe('ledger connection options', () => {
  it('sets a statement timeout — the lock is platform-wide, so a hang is too', () => {
    const options = ledgerPostgresOptions(ENV);
    expect(options.connection).toMatchObject({ statement_timeout: LEDGER_STATEMENT_TIMEOUT_MS });
    expect(LEDGER_STATEMENT_TIMEOUT_MS).toBeGreaterThan(0);
    // Matches packages/db's default on purpose: the most money-critical service
    // must not be the one running looser limits than the shared helper it skipped.
    expect(LEDGER_STATEMENT_TIMEOUT_MS).toBe(15_000);
  });

  it("ends a transaction that goes quiet — 60 s, the shared helper's value", () => {
    // The statement timeout bounds one statement, not the gap between them. A
    // stalled caller would otherwise hold the chain_tip lock indefinitely, and
    // svc-bank's recovery bound (7 minutes after the last attempt) counts on
    // this ceiling. Pinned: raising it also means raising that bound.
    expect(ledgerPostgresOptions(ENV).connection).toMatchObject({
      idle_in_transaction_session_timeout: LEDGER_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    });
    expect(LEDGER_IDLE_IN_TRANSACTION_TIMEOUT_MS).toBe(60_000);
  });

  it('bounds how long a connection attempt can block', () => {
    expect(ledgerPostgresOptions(ENV).connect_timeout).toBe(LEDGER_CONNECT_TIMEOUT_S);
  });

  it('keeps the search path and application name that made this pool bespoke', () => {
    // The only reason this service does not use `createDb`. If these ever stop
    // being needed, the whole module should go and `createDb` should be used.
    expect(ledgerPostgresOptions(ENV).connection).toMatchObject({
      search_path: 'ledger,public',
      application_name: 'svc-ledger',
    });
  });

  it('carries the pool size and TLS choice through from env', () => {
    expect(ledgerPostgresOptions({ ...ENV, DATABASE_POOL_MAX: 3, DATABASE_SSL: true })).toMatchObject({
      max: 3,
      ssl: 'require',
    });
    expect(ledgerPostgresOptions(ENV).ssl).toBe(false);
  });
});
