import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { formatAmount, parseAmount as amt, railBoundary, userAvailable } from '@intafaced/ledger-client';
import { PostgresLedger } from './postgres-ledger.js';
import { HISTORY_MAX_ENTRIES, HistoryTooLargeError } from './history.js';
import { disableBalanceTrigger } from '../db/journal-guards.testkit.js';

/**
 * THE READ `/bank/analytics` 500-ed ON, against a real book.
 *
 * svc-bank's spend view called `POST /trpc/history`, svc-ledger had no such
 * procedure, and Fastify answered `404 Route POST:/trpc/history not found`. Its
 * client refused to fall back to an empty result — correctly, since a spend view
 * reporting zero is indistinguishable from one that could not ask — so the whole
 * screen returned 500.
 *
 * What is proved here is the half that only a database can prove: that the SQL
 * window agrees with the window rules in `history.ts`, that entries from another
 * account cannot leak into an answer, that 18-decimal amounts survive the round
 * trip through `numeric(38,18)` unrounded, and that the cap refuses at exactly
 * the row it says it does.
 *
 * H8a PG-hard: this file never `describe.skip` / `postgresAvailable`. CI uses
 * TEST_DATABASE_URL (per-run schema via `createTestDb`). Local without that env
 * starts Testcontainers `postgres:16-alpine`. Docker/PG down is a failed suite,
 * not a green skip.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');

const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'))
  .map((body) => (schema: string) => rewriteSchemaSql(body, 'ledger', schema));

const SPENDER = '11111111-1111-4111-8111-111111111111';
const STRANGER = '22222222-2222-4222-8222-222222222222';
/** A user who exists and has never moved a thing. The honest-empty case. */
const QUIET = '33333333-3333-4333-8333-333333333333';

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
      `H8a: ledger history is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('PostgresLedger.history PG-hard (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('PostgresLedger.history', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDb | undefined;
  let engine: PostgresLedger;

  /** Timestamps of the three movements posted below, in commit order. */
  let deposited: Date;
  let spent: Date;
  let refunded: Date;

  const deposit = (userId: string, key: string, value: string) => ({
    idempotencyKey: key,
    module: 'bank',
    reason: 'bank.transfer.in',
    entries: [
      { account: userAvailable(userId, 'USDT'), direction: 'debit' as const, amount: amt(value) },
      { account: railBoundary('crypto-native', 'USDT'), direction: 'credit' as const, amount: amt(value) },
    ],
  });

  const spend = (userId: string, key: string, value: string, reason: string) => ({
    idempotencyKey: key,
    module: 'trade',
    reason,
    entries: [
      { account: userAvailable(userId, 'USDT'), direction: 'credit' as const, amount: amt(value) },
      { account: railBoundary('crypto-native', 'USDT'), direction: 'debit' as const, amount: amt(value) },
    ],
  });

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDb({ service: 'ledger_history', url: admin.url, migrations });
    // Raw fixtures below insert one-sided entries on purpose (they test other guards).
    // 0023's balance-at-commit trigger has its own file: journal-immutable.db.test.ts.
    await disableBalanceTrigger(db.sql);
    engine = new PostgresLedger(db.sql);

    // An 18-decimal amount, deliberately: the whole point of `numeric(38,18)`
    // and scaled bigint is that this survives. A float loses it silently.
    deposited = (await engine.post(deposit(SPENDER, 'hist-deposit-1', '100.123456789012345678'))).postedAt;
    spent = (await engine.post(spend(SPENDER, 'hist-spend-1', '25.5', 'trade.fill'))).postedAt;
    refunded = (await engine.post(deposit(SPENDER, 'hist-refund-1', '0.000000000000000001'))).postedAt;

    // A second user moving money in the same window and the same asset. If the
    // account filter is wrong, these show up in the spender's history.
    await engine.post(deposit(STRANGER, 'hist-stranger-1', '999'));
    await engine.post(spend(STRANGER, 'hist-stranger-2', '9', 'trade.fill'));

    // An `available` account that HAS moved, used below to prove a `hold` on
    // the same (user, asset) is a different account and not this one.
    await engine.post(deposit(QUIET, 'hist-quiet-open', '1'));
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  const wide = () => ({ from: new Date(deposited.getTime() - 60_000), to: new Date(refunded.getTime() + 60_000) });

  /**
   * THE CONTRACT TEST. Every field svc-bank's `entriesFor` reads, and nothing
   * shaped differently.
   *
   * `createLedgerHistory` does `result.map((e) => ({ txId, module, reason,
   * direction, amount: parseAmount(e.amount), postedAt: new Date(e.postedAt) }))`.
   * Rename one key, return an object instead of an array, or send `amount` as a
   * number, and svc-bank breaks again — with `parseAmount` throwing
   * `MoneyError` on `undefined` rather than a 404, which is not an improvement.
   */
  it('returns exactly the shape svc-bank parses', async () => {
    const entries = await engine.history(userAvailable(SPENDER, 'USDT'), wide());

    expect(Array.isArray(entries)).toBe(true);
    expect(entries).toHaveLength(3);

    const first = entries[0]!;
    expect(Object.keys(first).sort()).toEqual(['amount', 'direction', 'module', 'postedAt', 'reason', 'txId']);
    expect(typeof first.txId).toBe('string');
    expect(first.module).toBe('bank');
    expect(first.reason).toBe('bank.transfer.in');
    expect(first.direction).toBe('debit');
    expect(first.postedAt).toBeInstanceOf(Date);

    // Money is a scaled bigint in memory — never a `number`, never a float.
    expect(typeof first.amount).toBe('bigint');
    expect(formatAmount(first.amount)).toBe('100.123456789012345678');
  });

  it('carries the ledger’s own reason codes through unaltered — they are what svc-bank categorises on', async () => {
    const entries = await engine.history(userAvailable(SPENDER, 'USDT'), wide());

    // `categorise()` in svc-bank keys off these prefixes: 'bank.transfer' →
    // transfers, 'trade.' → trading. A history that normalised or prettified
    // reasons would silently move every movement into `other`.
    expect(entries.map((e) => e.reason)).toEqual(['bank.transfer.in', 'trade.fill', 'bank.transfer.in']);
    expect(entries.map((e) => e.direction)).toEqual(['debit', 'credit', 'debit']);
  });

  it('preserves the smallest unit the book carries — 1e-18 is not rounded away', async () => {
    const entries = await engine.history(userAvailable(SPENDER, 'USDT'), wide());
    expect(formatAmount(entries[2]!.amount)).toBe('0.000000000000000001');
  });

  it('never leaks another account’s movements', async () => {
    const entries = await engine.history(userAvailable(SPENDER, 'USDT'), wide());

    // The stranger moved 999 and 9 in the same asset, in the same window.
    expect(entries.map((e) => formatAmount(e.amount))).not.toContain('999');
    expect(entries.map((e) => formatAmount(e.amount))).not.toContain('9');
  });

  it('is ordered oldest first, so a fold over it reads as a statement', async () => {
    const entries = await engine.history(userAvailable(SPENDER, 'USDT'), wide());
    const times = entries.map((e) => e.postedAt.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  // ── The window is half-open, and both ends are load-bearing ──────────────

  it('INCLUDES a movement posted at exactly `from`', async () => {
    // [deposited, spent) — `from` inclusive admits the deposit, `to` exclusive
    // holds back the very next movement. One window, both rules.
    const entries = await engine.history(userAvailable(SPENDER, 'USDT'), { from: deposited, to: spent });

    expect(entries).toHaveLength(1);
    expect(formatAmount(entries[0]!.amount)).toBe('100.123456789012345678');
  });

  it('EXCLUDES a movement posted at exactly `to`', async () => {
    // Consecutive windows must neither overlap nor drop a movement. If `to`
    // were inclusive, a movement at midnight would be counted in both months —
    // spending invented by a boundary.
    const entries = await engine.history(userAvailable(SPENDER, 'USDT'), {
      from: new Date(deposited.getTime() - 60_000),
      to: deposited,
    });

    expect(entries).toEqual([]);
  });

  // ── Honest empties — the cases that must NOT be errors ───────────────────

  it('answers an account that exists but moved nothing in the window with an empty array', async () => {
    const entries = await engine.history(userAvailable(SPENDER, 'USDT'), {
      from: new Date(refunded.getTime() + 60_000),
      to: new Date(refunded.getTime() + 120_000),
    });

    expect(entries).toEqual([]);
  });

  it('answers a zero-width window with an empty array', async () => {
    const entries = await engine.history(userAvailable(SPENDER, 'USDT'), { from: deposited, to: deposited });
    expect(entries).toEqual([]);
  });

  it('answers an account that has never been posted to with an empty array, and does not create it', async () => {
    const never = userAvailable('44444444-4444-4444-8444-444444444444', 'USDT');

    const entries = await engine.history(never, wide());
    expect(entries).toEqual([]);

    // A read must never have the side effect of creating an account — the same
    // rule `balance()` follows when it reports zero for one that does not exist.
    const rows = await db!.sql<Array<{ n: string }>>`
      SELECT count(*)::text AS n FROM accounts WHERE owner_id = ${never.ownerId}
    `;
    expect(rows[0]!.n).toBe('0');
  });

  it('does not confuse a hold with the available account it was funded from', async () => {
    // `purpose` is the fifth component of account identity. A history keyed on
    // four columns would merge an order's reservation into the spend view.
    const entries = await engine.history({ ...userAvailable(QUIET, 'USDT'), kind: 'hold', purpose: 'order:none' }, wide());
    expect(entries).toEqual([]);
  });

  // ── The cap, at the exact row it claims ─────────────────────────────────

  /**
   * Rows are bulk-inserted rather than posted through `post()`: 10 001 real
   * posts is 10 001 chain-tip locks, and this test is about the LIMIT, not
   * about the chain. The hash chain is deliberately not extended here, which is
   * also why this suite never calls `reconcile()`.
   */
  async function bulkEntries(userId: string, count: number, offset: number): Promise<void> {
    const accountId = (
      await db!.sql<Array<{ id: string }>>`
        INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose)
        VALUES ('user'::owner_type, ${userId}, 'USDT', 'available'::account_kind, '')
        ON CONFLICT (owner_type, owner_id, asset_id, kind, purpose) DO UPDATE SET owner_id = EXCLUDED.owner_id
        RETURNING id
      `
    )[0]!.id;

    await db!.sql`
      INSERT INTO ledger_tx (id, idempotency_key, module, reason, meta, posted_at, hash, previous_hash)
      SELECT gen_random_uuid(), 'bulk-' || ${userId} || '-' || i, 'bank', 'bank.transfer.in', '{}'::jsonb,
             timestamptz '2026-05-01T00:00:00Z' + (i * interval '1 second'), 'bulk-hash-' || i, NULL
        FROM generate_series(${offset + 1}::int, ${offset + count}::int) AS i
    `;

    await db!.sql`
      INSERT INTO ledger_entries (tx_id, account_id, asset_id, direction, amount, balance_after)
      SELECT t.id, ${accountId}::uuid, 'USDT', 'debit'::direction, 1::numeric, 1::numeric
        FROM ledger_tx t
       WHERE t.idempotency_key LIKE ${'bulk-' + userId + '-%'}
         AND NOT EXISTS (SELECT 1 FROM ledger_entries e WHERE e.tx_id = t.id)
    `;
  }

  const bulkWindow = { from: new Date('2026-04-01T00:00:00Z'), to: new Date('2026-06-01T00:00:00Z') };

  it('answers in full at exactly the cap — the bound is not off by one', async () => {
    const user = '55555555-5555-4555-8555-555555555555';
    await bulkEntries(user, HISTORY_MAX_ENTRIES, 0);

    const entries = await engine.history(userAvailable(user, 'USDT'), bulkWindow);
    expect(entries).toHaveLength(HISTORY_MAX_ENTRIES);
  }, 60_000);

  /**
   * THE TEST THIS CAP EXISTS FOR.
   *
   * One row past the cap and the read REFUSES. It does not return the first
   * 10 000 — an array of 10 000 entries is indistinguishable from a complete
   * one, so svc-bank would sum it and call the result the user's spending,
   * short by whatever fell off the end and with nothing anywhere saying so.
   * That is the same lie as the empty fallback its client already refuses.
   */
  it('REFUSES one row past the cap rather than truncating', async () => {
    const user = '66666666-6666-4666-8666-666666666666';
    await bulkEntries(user, HISTORY_MAX_ENTRIES + 1, 0);

    await expect(engine.history(userAvailable(user, 'USDT'), bulkWindow)).rejects.toThrow(HistoryTooLargeError);
    await expect(engine.history(userAvailable(user, 'USDT'), bulkWindow)).rejects.toMatchObject({
      code: 'ledger.history_range_too_large',
    });
  }, 60_000);

  it('a narrower window is a real remedy, not just advice in an error message', async () => {
    const user = '66666666-6666-4666-8666-666666666666';

    // The same account the refusal above came from, asked for half the window.
    const entries = await engine.history(userAvailable(user, 'USDT'), {
      from: new Date('2026-05-01T00:00:00Z'),
      to: new Date('2026-05-01T01:00:00Z'),
    });

    expect(entries.length).toBeLessThanOrEqual(HISTORY_MAX_ENTRIES);
    expect(entries.length).toBeGreaterThan(0);
  }, 60_000);
});
