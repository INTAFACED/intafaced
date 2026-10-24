import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { formatAmount, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { PostgresLedger } from './postgres-ledger.js';
import { recordOperatorAccess } from './operator-owner-balances.js';
import { DESK_PAGE_SIZE, listOperatorTransactions, readBookingRecord, readOperatorStats, searchOperatorAccounts } from './operator-desk.js';

/**
 * The ledger desk's reads against a real book (OPS-ledger-desk-01, J-ops-console-03 #1, #2, #4, #5): the list's filters,
 * cursor and total; the booking record beside one transaction; the address search's volumes; the counts; and the
 * access log taking the desk's two new actions (0028). TEST amounts only.
 *
 * PG-hard: this file never skips. CI uses TEST_DATABASE_URL. Local without that env starts Testcontainers.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'))
  .map((body) => (schema: string) => rewriteSchemaSql(body, 'ledger', schema));

const IMAGE = 'postgres:16-alpine';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OPERATOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USDT_DEPOSITS = DESK_PAGE_SIZE + 2;
/** A TEST amount times a count, as a decimal string; never a JS number. */
const times = (amount: string, n: number, sign = 1n) => formatAmount(sign * amt(amount) * BigInt(n));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  try {
    const container = await new PostgreSqlContainer(IMAGE)
      .withDatabase('intafaced_desk_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `The ledger desk reads are PG-hard (no skip-green). TEST_DATABASE_URL unset and Testcontainers could not start ${IMAGE}: ${msg}`,
    );
  }
}

describe('ledger desk reads PG-hard (source)', () => {
  it('is not skip-green', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('the ledger desk on a real book', () => {
  let stop: () => Promise<void> = async () => undefined;
  let db: TestDb | undefined;
  let btcTxId = '';
  let firstUsdtTxId = '';

  beforeAll(async () => {
    const admin = await openAdmin();
    stop = admin.stop;
    db = await createTestDb({ service: 'ledger_desk', url: admin.url, migrations });
    const engine = new PostgresLedger(db.sql);
    // A to B alternately, so the address search has two owners to tell apart.
    for (let i = 0; i < USDT_DEPOSITS; i++) {
      const tx = await engine.post(
        recipes.deposit({ userId: i % 2 === 0 ? A : B, assetId: 'USDT', amount: amt('1.5'), rail: 'desk-test', railRef: `usdt-${i}` }),
      );
      if (i === 0) firstUsdtTxId = tx.id;
    }
    btcTxId = (await engine.post(recipes.deposit({ userId: A, assetId: 'BTC', amount: amt('0.25'), rail: 'desk-test', railRef: 'btc-1' })))
      .id;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await stop();
  }, 30_000);

  it('lists newest first with the ledger’s total, and the cursor walks the rest without repeating a row', async () => {
    const sql = db!.sql;
    const first = await listOperatorTransactions(sql, {});
    expect(first.total).toBe(String(USDT_DEPOSITS + 1));
    expect(first.rows).toHaveLength(DESK_PAGE_SIZE);
    expect(first.rows[0]).toMatchObject({ txId: btcTxId, businessKey: 'deposit:desk-test:btc-1', assets: ['BTC'], postings: '2' });
    const seqs = first.rows.map((r) => BigInt(r.seq));
    expect(seqs).toEqual([...seqs].sort((x, y) => (x > y ? -1 : x < y ? 1 : 0)));
    expect(first.nextCursor).toBe(first.rows.at(-1)!.seq);

    const second = await listOperatorTransactions(sql, { before: first.nextCursor! });
    // A later page does not count again: the first page's total stands.
    expect(second.total).toBeNull();
    expect(second.rows).toHaveLength(USDT_DEPOSITS + 1 - DESK_PAGE_SIZE);
    expect(second.nextCursor).toBeNull();
    expect(second.rows.at(-1)!.txId).toBe(firstUsdtTxId);
    const ids = new Set([...first.rows, ...second.rows].map((r) => r.txId));
    expect(ids.size).toBe(USDT_DEPOSITS + 1);
  });

  it('filters by asset and by a half-open time window', async () => {
    const sql = db!.sql;
    const btc = await listOperatorTransactions(sql, { assetId: 'BTC' });
    expect(btc).toMatchObject({ total: '1', nextCursor: null, rows: [{ txId: btcTxId }] });
    expect((await listOperatorTransactions(sql, { assetId: 'ETH' })).total).toBe('0');

    const later = new Date(Date.now() + 3_600_000).toISOString();
    expect(await listOperatorTransactions(sql, { from: later })).toEqual({ total: '0', rows: [], nextCursor: null });
    const all = await listOperatorTransactions(sql, { from: '2026-01-01T00:00:00Z', to: later, assetId: 'USDT' });
    expect(all.total).toBe(String(USDT_DEPOSITS));
  });

  it('answers each transaction’s place in the log, its booking time and its tx.posted record', async () => {
    const sql = db!.sql;
    const booking = await readBookingRecord(sql, btcTxId);
    const [row] = await sql<Array<{ seq: string }>>`SELECT seq::text AS seq FROM ledger_tx WHERE id = ${btcTxId}`;
    expect(booking).toMatchObject({
      seq: row!.seq,
      // No correlation id on the request: the ledger records the transaction id as its reference.
      reference: btcTxId,
      event: { subject: 'intafaced.ledger.tx.posted', publishedAt: null },
    });
    expect(booking!.bookedAt).toBe(booking!.event!.recordedAt);
    expect(await readBookingRecord(sql, '99999999-9999-4999-8999-999999999999')).toBeNull();
  });

  it('finds accounts by address prefix with their volumes and the balance derived from them', async () => {
    const sql = db!.sql;
    const a = await searchOperatorAccounts(sql, { prefix: `user:${A.slice(0, 8)}` });
    expect(a.nextCursor).toBeNull();
    const byAsset = Object.fromEntries(a.accounts.map((r) => [r.assetId, r]));
    const aDeposits = Math.ceil(USDT_DEPOSITS / 2);
    expect(byAsset.USDT).toMatchObject({
      address: `user:${A}`,
      ownerType: 'user',
      debits: times('1.5', aDeposits),
      credits: '0',
      balance: times('1.5', aDeposits),
      postings: String(aDeposits),
    });
    expect(byAsset.BTC).toMatchObject({ debits: '0.25', credits: '0', balance: '0.25' });
    expect(a.accounts.every((r) => r.ownerId === A)).toBe(true);

    const rail = await searchOperatorAccounts(sql, { prefix: 'treasury:rail:desk' });
    const usdtRail = rail.accounts.find((r) => r.assetId === 'USDT')!;
    expect(usdtRail).toMatchObject({
      address: 'treasury:rail:desk-test',
      debits: '0',
      credits: times('1.5', USDT_DEPOSITS),
      balance: times('1.5', USDT_DEPOSITS, -1n),
    });

    // The prefix is taken literally: a wildcard in it matches nothing.
    expect((await searchOperatorAccounts(sql, { prefix: 'treasury:%' })).accounts).toEqual([]);
    expect((await searchOperatorAccounts(sql, { prefix: 'treasury:rail_desk' })).accounts).toEqual([]);
  });

  it('walks a search past one page with its cursor', async () => {
    const sql = db!.sql;
    const all = await searchOperatorAccounts(sql, { prefix: 'user:' + A.slice(0, 1) });
    // The first page holds both of A's accounts; a cursor after the first leaves the second.
    const next = await searchOperatorAccounts(sql, { prefix: 'user:' + A.slice(0, 1), after: all.accounts[0]!.accountId });
    expect(next.accounts.map((r) => r.accountId)).toEqual(all.accounts.slice(1).map((r) => r.accountId));
  });

  it('counts the book', async () => {
    const stats = await readOperatorStats(db!.sql);
    expect(stats).toMatchObject({
      transactions: String(USDT_DEPOSITS + 1),
      postings: String(2 * (USDT_DEPOSITS + 1)),
      // A and B in USDT, A in BTC, and the rail in each.
      accounts: '5',
      assets: '2',
    });
    const [last] = await db!.sql<Array<{ seq: string }>>`SELECT max(seq)::text AS seq FROM ledger_tx`;
    expect(stats.lastSeq).toBe(last!.seq);
    expect(Date.parse(stats.asOf)).not.toBeNaN();
  });

  it('records the desk’s list and search in the access log, and refuses an action it does not know (0028)', async () => {
    const sql = db!.sql;
    await recordOperatorAccess(sql, {
      actorId: OPERATOR,
      ownerType: 'transactions',
      ownerId: 'asset=* from=* to=* before=*',
      requestId: 'desk-1',
      action: 'transactions.list',
    });
    await recordOperatorAccess(sql, {
      actorId: OPERATOR,
      ownerType: 'address_prefix',
      ownerId: 'house:fees',
      requestId: 'desk-2',
      action: 'accounts.search',
    });
    const rows = await sql`SELECT action FROM operator_access_log WHERE request_id IN ('desk-1', 'desk-2') ORDER BY request_id`;
    expect(rows.map((r) => r.action)).toEqual(['transactions.list', 'accounts.search']);
    await expect(
      sql`INSERT INTO operator_access_log (actor_id, action, target_owner_type, target_owner_id) VALUES (${OPERATOR}, 'ledger.dump', 'x', 'y')`,
    ).rejects.toThrow(/operator_access_log_action_ck/);
  });
});
