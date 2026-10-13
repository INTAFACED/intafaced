import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { runLedgerConformance } from '@intafaced/ledger-client/testing';
import {
  formatAmount,
  parseAmount as amt,
  recipes,
  userAvailable,
  UnbalancedTransactionError,
  InvalidEntryError,
  InsufficientFundsError,
} from '@intafaced/ledger-client';
import { PostgresLedger } from './postgres-ledger.js';
import { HistoryTooLargeError } from './history.js';
import { reconcileBalances, verifyChain, totalsByAsset, runReconciliation } from './reconcile.js';

/**
 * svc-ledger runs the SAME conformance suite as the in-memory reference
 * (§4.4). If the two ever disagree, one of them is wrong and the suite decides.
 *
 * Isolation: every suite run gets its own Postgres schema via `createTestDb`.
 * Two worktrees can run this file at once without TRUNCATE races on the shared
 * `ledger` schema (the failure mode that looks exactly like insufficient-funds).
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run schema via `createTestDb`). Local without that env
 * starts Testcontainers `postgres:16-alpine`. Docker/PG down is a failed suite,
 * not a green skip.
 *
 * Paged history is a §13 socket (`after` cursor). Until that exists, over-cap
 * reads refuse — they do not truncate. That contract is proved in
 * `history-postgres.test.ts`; this file does not recut it.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');

/**
 * EVERY forward migration, in order — not just the initial one.
 *
 * Read from disk rather than listed here. A hardcoded filename means the test
 * schema silently drifts from the real one the first time someone adds a
 * migration, and the failure surfaces as "column does not exist" in unrelated
 * tests rather than as anything pointing at the cause.
 */
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'))
  .map((body) => (schema: string) => rewriteSchemaSql(body, 'ledger', schema));

if (migrations.length === 0) throw new Error(`No migrations found in ${drizzleDir}`);

const H8A_IMAGE = 'postgres:16-alpine';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) {
    return { url: envUrl, stop: async () => undefined };
  }

  try {
    const container = await new PostgreSqlContainer(H8A_IMAGE)
      .withDatabase('intafaced_h8a_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return {
      url: container.getConnectionUri(),
      stop: async () => {
        await container.stop();
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `H8a: postgres-ledger is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('PostgresLedger PG-hard (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('PostgresLedger', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDb | undefined;
  let engine: PostgresLedger;

  /**
   * Wipe transactional state without dropping the singleton chain tip or the
   * asset seed — same shape as the old shared-schema truncate, scoped to
   * *this* suite's schema via search_path.
   */
  const reset = async () => {
    await db!.sql`
      TRUNCATE ledger_tx_outbox, ledger_entries, ledger_tx, balance_snapshots, accounts RESTART IDENTITY CASCADE
    `;
    await db!.sql`UPDATE chain_tip SET hash = NULL, seq = 0 WHERE id = true`;
  };

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDb({ service: 'ledger', url: admin.url, migrations });
    engine = new PostgresLedger(db.sql);
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  runLedgerConformance('PostgresLedger', async () => ({
    ledger: engine,
    reset,
    journal: () => engine.journal(),
    reconcile: async () => reconcileBalances(db!.sql),
    verifyChain: async () => verifyChain(db!.sql),
    totalsByAsset: async () => totalsByAsset(db!.sql),
  }));

  // ── Postgres-specific behaviour the reference cannot exercise ──────────────

  describe('svc-ledger — database-level guarantees', () => {
    beforeAll(reset);

    const USER = '99999999-9999-4999-8999-999999999999';

    it('uses a unique schema so parallel suites cannot share state', () => {
      // Structural guarantee: createTestDb names include pid + counter.
      expect(db!.schema).toMatch(/^test_ledger_\d+_\d+$/);
      expect(db!.schema).not.toBe('ledger');
    });

    it('refuses an unbalanced post before any row is written', async () => {
      await reset();
      await expect(
        engine.post({
          idempotencyKey: 'unbalanced-engine-1',
          module: 'test',
          reason: 'unbalanced',
          entries: [
            { account: userAvailable(USER, 'USDT'), direction: 'debit', amount: amt('10') },
            { account: userAvailable(USER, 'USDT'), direction: 'credit', amount: amt('9') },
          ],
        }),
      ).rejects.toBeInstanceOf(UnbalancedTransactionError);
      expect(await engine.journal()).toEqual([]);
    });

    it('refuses a JS-number amount rather than mixing it into bigint math', async () => {
      await reset();
      await expect(
        engine.post({
          idempotencyKey: 'js-number-engine-1',
          module: 'test',
          reason: 'number-amount',
          entries: [
            { account: userAvailable(USER, 'USDT'), direction: 'debit', amount: 10 as never },
            { account: userAvailable(USER, 'USDT'), direction: 'credit', amount: 10 as never },
          ],
        }),
      ).rejects.toBeInstanceOf(InvalidEntryError);
      expect(await engine.journal()).toEqual([]);
    });

    it('refuses a spend that would take a user negative, without writing', async () => {
      await reset();
      await engine.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('10'), rail: 'test', railRef: 'neg-1' }));
      await expect(
        engine.post(recipes.orderHold({ orderId: 'neg-hold', userId: USER, assetId: 'USDT', amount: amt('50') })),
      ).rejects.toBeInstanceOf(InsufficientFundsError);
      expect(formatAmount((await engine.balance(userAvailable(USER, 'USDT'))).amount)).toBe('10');
    });

    it('the database itself refuses a negative non-treasury balance', async () => {
      // Bypass the service entirely: even direct SQL cannot create money.
      await db!.sql`
        INSERT INTO accounts (owner_type, owner_id, asset_id, kind)
        VALUES ('user', ${USER}, 'BTC', 'available')
        ON CONFLICT DO NOTHING
      `;

      await expect(
        db!.sql`UPDATE accounts SET balance = -1 WHERE owner_type = 'user' AND owner_id = ${USER} AND asset_id = 'BTC'`,
      ).rejects.toThrow(/accounts_non_negative_ck/);
    });

    it('the database itself refuses a zero-amount entry', async () => {
      const [tx] = await db!.sql<Array<{ id: string }>>`
        INSERT INTO ledger_tx (idempotency_key, module, reason, hash)
        VALUES (${`ck-test-${Date.now()}`}, 'test', 'test', 'deadbeef') RETURNING id
      `;
      const [account] = await db!.sql<Array<{ id: string }>>`
        SELECT id FROM accounts WHERE owner_type = 'user' AND owner_id = ${USER} AND asset_id = 'BTC'
      `;

      await expect(
        db!.sql`
          INSERT INTO ledger_entries (tx_id, account_id, asset_id, direction, amount, balance_after)
          VALUES (${tx!.id}, ${account!.id}, 'BTC', 'debit', 0, 0)
        `,
      ).rejects.toThrow(/ledger_entries_positive_ck/);
    });

    it('rejects a duplicate idempotency key at the unique index', async () => {
      const key = `dupe-test-${Date.now()}`;
      await db!.sql`INSERT INTO ledger_tx (idempotency_key, module, reason, hash) VALUES (${key}, 't', 't', 'a')`;
      await expect(db!.sql`INSERT INTO ledger_tx (idempotency_key, module, reason, hash) VALUES (${key}, 't', 't', 'b')`).rejects.toThrow(
        /ledger_tx_idempotency_idx/,
      );
    });

    it('preserves full 18-decimal precision through a round trip', async () => {
      await reset();
      const precise = '0.123456789012345678';
      await engine.post(recipes.deposit({ userId: USER, assetId: 'ETH', amount: amt(precise), rail: 'test', railRef: 'precision-1' }));
      const balance = await engine.balance(userAvailable(USER, 'ETH'));
      expect(formatAmount(balance.amount)).toBe(precise);
    });

    it('records balance_after on every entry, matching the final state', async () => {
      await reset();
      await engine.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('100'), rail: 'test', railRef: 'ba-1' }));
      await engine.post(recipes.orderHold({ orderId: 'ba-o1', userId: USER, assetId: 'USDT', amount: amt('30') }));

      const journal = await engine.journal();
      const last = journal.at(-1)!;
      const availableLeg = last.entries.find((e) => e.direction === 'credit')!;
      expect(formatAmount(availableLeg.balanceAfter)).toBe('70');
    });

    it('detects tampering after the fact', async () => {
      await reset();
      await engine.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('100'), rail: 'test', railRef: 'tamper-1' }));
      await engine.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('200'), rail: 'test', railRef: 'tamper-2' }));

      expect(await verifyChain(db!.sql)).toMatchObject({ ok: true });

      // Someone with database access inflates an entry.
      await db!.sql`
        UPDATE ledger_entries SET amount = 999999
         WHERE id = (SELECT MIN(id) FROM ledger_entries)
      `;

      const result = await verifyChain(db!.sql);
      expect(result.ok).toBe(false);
    });

    it('a posted chain is not ok when the tip hash is not the last transaction hash', async () => {
      await reset();
      await engine.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('100'), rail: 'test', railRef: 'tip-1' }));
      await engine.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('40'), rail: 'test', railRef: 'tip-2' }));

      expect(await verifyChain(db!.sql)).toMatchObject({ ok: true });

      const rows = await db!.sql<Array<{ hash: string }>>`SELECT hash FROM ledger_tx ORDER BY seq ASC`;
      const earlier = rows[0]!.hash;
      const last = rows.at(-1)!.hash;
      expect(earlier).not.toBe(last);

      await db!.sql`UPDATE chain_tip SET hash = ${earlier} WHERE id = true`;

      expect((await verifyChain(db!.sql)).ok).toBe(false);
    });

    it('reconciliation catches a balance that no longer matches its entries', async () => {
      await reset();
      await engine.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('100'), rail: 'test', railRef: 'recon-1' }));

      expect(await reconcileBalances(db!.sql)).toMatchObject({ ok: true });

      // Corrupt the denormalised cache without touching the entries.
      await db!.sql`
        UPDATE accounts SET balance = 150
         WHERE owner_type = 'user' AND owner_id = ${USER} AND asset_id = 'USDT' AND kind = 'available'
      `;

      const result = await reconcileBalances(db!.sql);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.drift[0]?.cached).toBe('150');
        expect(result.drift[0]?.replayed).toBe('100');
        expect(result.drift[0]?.difference).toBe('50');
      }
    });

    it('a full reconciliation run reports every asset netting to zero', async () => {
      await reset();
      await engine.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('500'), rail: 'test', railRef: 'full-1' }));
      await engine.post(recipes.orderHold({ orderId: 'full-o1', userId: USER, assetId: 'USDT', amount: amt('200') }));

      const report = await runReconciliation(db!.sql);
      expect(report.ok).toBe(true);
      expect(report.unbalancedAssets).toEqual([]);
      expect(report.totals.USDT).toBe('0');
    });

    it('holds zero drift across 200 sequential posts', async () => {
      await reset();
      await engine.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('100000'), rail: 'test', railRef: 'vol-1' }));

      for (let i = 0; i < 100; i++) {
        await engine.post(recipes.orderHold({ orderId: `vol-${i}`, userId: USER, assetId: 'USDT', amount: amt('10') }));
        await engine.post(recipes.orderHoldRelease({ orderId: `vol-${i}`, userId: USER, assetId: 'USDT', amount: amt('10') }));
      }

      expect(formatAmount((await engine.balance(userAvailable(USER, 'USDT'))).amount)).toBe('100000');
      expect(await reconcileBalances(db!.sql)).toMatchObject({ ok: true });
      expect(await verifyChain(db!.sql)).toMatchObject({ ok: true });
      expect((await totalsByAsset(db!.sql)).USDT).toBe('0');
    }, 60_000);

    it('serialises 50 concurrent posts without drift or a broken chain', async () => {
      await reset();
      await engine.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('10000'), rail: 'test', railRef: 'conc-1' }));

      await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          engine.post(recipes.orderHold({ orderId: `conc-${i}`, userId: USER, assetId: 'USDT', amount: amt('10') })),
        ),
      );

      expect(formatAmount((await engine.balance(userAvailable(USER, 'USDT'))).amount)).toBe('9500');
      expect(await reconcileBalances(db!.sql)).toMatchObject({ ok: true });
      // The chain must still be intact: concurrency must not fork it.
      expect(await verifyChain(db!.sql)).toMatchObject({ ok: true });
    }, 60_000);

    /**
     * Rows booked before migration 0021 have no stored request digest, and the
     * claim table is append-only, so they cannot be backfilled. For those the
     * engine keeps the old answer (the original transaction) rather than refusing
     * every legacy retry. A row WITH a digest refuses a different body (conformance).
     */
    it('keeps answering a legacy claim (no stored digest) with the original, and stores a digest for new posts', async () => {
      await reset();
      const first = await engine.post(
        recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('7'), rail: 'test', railRef: 'legacy-claim' }),
      );
      const [stored] = await db!.sql<Array<{ request_fingerprint: string | null }>>`
        SELECT request_fingerprint FROM ledger_posted_keys WHERE tx_id = ${first.id}
      `;
      expect(stored?.request_fingerprint).toMatch(/^[0-9a-f]{64}$/);

      await db!.sql`ALTER TABLE ledger_posted_keys DISABLE TRIGGER ledger_posted_keys_immutable`;
      try {
        await db!.sql`UPDATE ledger_posted_keys SET request_fingerprint = NULL WHERE tx_id = ${first.id}`;
      } finally {
        await db!.sql`ALTER TABLE ledger_posted_keys ENABLE TRIGGER ledger_posted_keys_immutable`;
      }
      const other = recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('70'), rail: 'test', railRef: 'legacy-claim' });
      expect((await engine.post(other)).id).toBe(first.id);
    });

    /**
     * journal() is the replay source: every transaction, in commit order.
     * One row past the requested limit must refuse, the same way history()
     * refuses rather than handing back a prefix that looks complete.
     * Limit 2 stands in for the default 10_000 — it is the same parameter.
     */
    it('REFUSES a journal larger than the requested limit rather than returning a short prefix', async () => {
      await reset();
      const keys = ['deposit:test:journal-cap-1', 'deposit:test:journal-cap-2', 'deposit:test:journal-cap-3'] as const;

      await engine.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('1'), rail: 'test', railRef: 'journal-cap-1' }));
      await engine.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('1'), rail: 'test', railRef: 'journal-cap-2' }));

      const fitted = await engine.journal(2);
      expect(fitted.map((tx) => tx.idempotencyKey)).toEqual([keys[0], keys[1]]);

      await engine.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('1'), rail: 'test', railRef: 'journal-cap-3' }));

      await expect(engine.journal(2)).rejects.toThrow(HistoryTooLargeError);
      await expect(engine.journal(2)).rejects.toMatchObject({
        code: 'ledger.history_range_too_large',
        limit: 2,
      });

      const complete = await engine.journal(3);
      expect(complete.map((tx) => tx.idempotencyKey)).toEqual([...keys]);
    });
  });
});
