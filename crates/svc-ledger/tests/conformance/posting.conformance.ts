/**
 * The `posting` slice against the TypeScript ledger's own conformance suite (`runLedgerConformance`,
 * `@intafaced/ledger-client/testing`), run unmodified twice, through the `post` door each time:
 *
 * - `ts door`: `handleS2sPost` over `LedgerService` and `PostgresLedger`, the service that runs today, in its own schema;
 * - `rust door`: the Rust binary (`target/debug/svc-ledger`), serving `POST /trpc/post` over HTTP on a database of its
 *   own, reached with the real HTTP client (`createHttpLedgerClient`) signed with the shared secret.
 *
 * Both answer a refusal the way the door does (`httpError`, then the client's `rehydrateLedgerHttpError`), so a case
 * the door refuses before the engine (the input schema, the recipe gate) fails the same way on both. `compare.mjs`
 * holds the two runs to the same result, case for case. The reads the suite makes (balances, the journal, the chain and
 * reconciliation checks) are the TypeScript's own, on the book each door wrote: a book the Rust door wrote has to
 * verify and reconcile under the TypeScript's checks.
 *
 * Run with `run.mjs`, which says how.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { runLedgerConformance } from '../../../../packages/ledger-client/dist/testing/conformance.js';
import {
  createHttpLedgerClient,
  ledgerPostWire,
  parseLedgerPostAck,
  type LedgerClient,
  type PostRequest,
} from '../../../../packages/ledger-client/dist/index.js';
import { createTestDb, rewriteSchemaSql } from '../../../../packages/db/dist/index.js';
import { PostgresLedger } from '../../../../services/svc-ledger/src/ledger/postgres-ledger.ts';
import { LedgerService } from '../../../../services/svc-ledger/src/service.ts';
import { handleS2sPost } from '../../../../services/svc-ledger/src/s2s-http.ts';
import { reconcileBalances, totalsByAsset, verifyChain } from '../../../../services/svc-ledger/src/ledger/reconcile.ts';
import { truncateBook } from '../../../../services/svc-ledger/src/db/journal-guards.testkit.ts';
import { asClientError, DIRECT, overTheWire } from './door-client.ts';
import { openRustBook, signerFor } from './rust-door.ts';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const admin = process.env.TEST_DATABASE_URL?.trim();
if (!admin) throw new Error('TEST_DATABASE_URL is required: an admin database whose name ends in _test');

/** The book's reads, the TypeScript's, on whichever book a door wrote. */
function reads(sql: postgres.Sql) {
  const engine = new PostgresLedger(sql);
  return {
    balance: engine.balance.bind(engine),
    balances: engine.balances.bind(engine),
    getTx: engine.getTx.bind(engine),
    getTxByKey: engine.getTxByKey.bind(engine),
    journal: () => engine.journal(),
  };
}

const reset = async (sql: postgres.Sql) => {
  await truncateBook(sql, 'ledger_tx_outbox, ledger_entries, ledger_tx, balance_snapshots, accounts RESTART IDENTITY CASCADE');
  await sql`UPDATE chain_tip SET hash = NULL, seq = 0 WHERE id = true`;
};

const checks = (sql: postgres.Sql) => ({
  reconcile: async () => reconcileBalances(sql),
  verifyChain: async () => verifyChain(sql),
  totalsByAsset: async () => totalsByAsset(sql),
});

// ── The TypeScript door ────────────────────────────────────────────────────────────────────────────────────────────

runLedgerConformance('ts door', async () => {
  const drizzle = `${ROOT}services/svc-ledger/drizzle/`;
  const migrations = readdirSync(drizzle)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort()
    .map((f) => readFileSync(`${drizzle}${f}`, 'utf8'))
    .map((body) => (schema: string) => rewriteSchemaSql(body, 'ledger', schema));
  const db = await createTestDb({ service: 'ledger_conf', url: admin, migrations });
  const bus = { publish: async () => ({}) } as never;
  const service = new LedgerService(db.sql, bus, { custodyLayer: 'on', idempotencyConflict: 'refuse' });
  const r = reads(db.sql);
  const ledger: LedgerClient = {
    ...r,
    async post(request: PostRequest) {
      const wire = JSON.parse(JSON.stringify(ledgerPostWire(request)));
      try {
        const ack = await handleS2sPost(service, wire, { kind: 'legacy', claimed: DIRECT }, {});
        return parseLedgerPostAck(request, JSON.parse(JSON.stringify(ack)));
      } catch (err) {
        throw overTheWire(err);
      }
    },
  };
  return { ledger, reset: () => reset(db.sql), journal: r.journal, ...checks(db.sql), teardown: () => db.drop() };
});

// ── The Rust door ──────────────────────────────────────────────────────────────────────────────────────────────────

async function rustHarness() {
  const book = await openRustBook(admin);
  const http = createHttpLedgerClient({ baseUrl: book.plain, sign: signerFor(DIRECT, false) as never, retries: 0 });
  const r = reads(book.sql);
  const ledger: LedgerClient = {
    ...r,
    post: (request: PostRequest) => http.post(request).catch((err) => Promise.reject(asClientError(err))),
  };
  return { ledger, reset: () => reset(book.sql), journal: r.journal, ...checks(book.sql), teardown: () => book.teardown() };
}

runLedgerConformance('rust door', rustHarness);
