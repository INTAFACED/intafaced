import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { formatAmount, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';
import { parseStoredAmount } from './live-money.js';
import { hashTx, PostgresLedger } from './postgres-ledger.js';
import { verifyChain } from './reconcile.js';

/**
 * The idempotency key is the identity of a movement. Rewriting it on the
 * posted row used to leave verifyChain green, and the next post of the
 * original key missed the row and moved the money again.
 *
 * H8a PG-hard: no describe.skip, no postgresAvailable.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');

const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'))
  .map((body) => (schema: string) => rewriteSchemaSql(body, 'ledger', schema));

const H8A_IMAGE = 'postgres:16-alpine';
const USER = '99999999-9999-4999-8999-999999999999';
const CHECK_VIOLATION = '23514';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };

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
      `H8a: tx-hash-bind is PG-hard (no skip-green). TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('svc-ledger tx-hash-bind PG-hard (source)', () => {
  it('H8a money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('ledger_tx key and meta stay bound to the posted movement', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDb | undefined;
  let engine: PostgresLedger;

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDb({ service: 'ledger_txhash', url: admin.url, migrations });
    engine = new PostgresLedger(db.sql);
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  it('refuses a rewritten key, and the original key does not post again', async () => {
    if (!db) throw new Error('H8a: test db not opened');
    const first = await engine.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('10'), rail: 'test', railRef: 'bind-1' }));
    expect(await verifyChain(db.sql)).toMatchObject({ ok: true });
    expect(formatAmount((await engine.balance(userAvailable(USER, 'USDT'))).amount)).toBe('10');

    await expect(db.sql`UPDATE ledger_tx SET idempotency_key = ${'rewritten-key'} WHERE id = ${first.id}`).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });
    await expect(db.sql`UPDATE ledger_tx SET meta = ${db.sql.json({ rail: 'swapped' })} WHERE id = ${first.id}`).rejects.toMatchObject({
      code: CHECK_VIOLATION,
    });

    const again = await engine.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('10'), rail: 'test', railRef: 'bind-1' }));
    expect(again.id).toBe(first.id);
    expect(formatAmount((await engine.balance(userAvailable(USER, 'USDT'))).amount)).toBe('10');
    expect(await verifyChain(db.sql)).toMatchObject({ ok: true });

    // A role that can disable the trigger can change the key. The stored hash
    // was computed with the original key, so the chain must not stay green.
    await db.sql`ALTER TABLE ledger_tx DISABLE TRIGGER ledger_tx_key_immutable`;
    await db.sql`UPDATE ledger_tx SET idempotency_key = ${'rewritten-key'} WHERE id = ${first.id}`;
    const broken = await verifyChain(db.sql);
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.brokenAt).toBe(first.id);

    // The column no longer holds the original key. The claim still does, so
    // this post must not move the balance a second time.
    await expect(
      engine.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('10'), rail: 'test', railRef: 'bind-1' })),
    ).rejects.toBeTruthy();
    expect(formatAmount((await engine.balance(userAvailable(USER, 'USDT'))).amount)).toBe('10');
    const rows = await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM ledger_tx`;
    expect(rows[0]?.n).toBe('1');
  });
});

/**
 * Digest of the row with the key omitted — the hash a pre-bind post stored,
 * which remains the current shared hash contract.
 */
async function legacyShortDigest(sql: TestDb['sql'], txId: string): Promise<string> {
  const [tx] = await sql<
    Array<{ id: string; module: string; reason: string; posted_at: Date; previous_hash: string | null }>
  >`SELECT id, module, reason, posted_at, previous_hash FROM ledger_tx WHERE id = ${txId}`;
  if (!tx) throw new Error(`no ledger_tx ${txId}`);
  const entries = await sql<
    Array<{ account_id: string; asset_id: string; direction: 'debit' | 'credit'; amount: string; balance_after: string }>
  >`
    SELECT account_id, asset_id, direction, amount, balance_after
      FROM ledger_entries WHERE tx_id = ${txId} ORDER BY id ASC
  `;
  return hashTx(
    {
      id: tx.id,
      module: tx.module,
      reason: tx.reason,
      postedAt: tx.posted_at,
      entries: entries.map((e) => ({
        id: '',
        txId: tx.id,
        accountId: e.account_id,
        assetId: e.asset_id,
        direction: e.direction,
        amount: parseStoredAmount(e.amount, 'ledger_entries.amount'),
        balanceAfter: parseStoredAmount(e.balance_after, 'ledger_entries.balance_after'),
      })),
    },
    tx.previous_hash,
  );
}

const priorMigrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql') && f < '0018')
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'))
  .map((body) => (schema: string) => rewriteSchemaSql(body, 'ledger', schema));

/** A 10 USDT deposit whose stored hash never covered the key, plus the 0015 claim. */
async function insertHistoricalDeposit(database: TestDb, railRef: string): Promise<{ id: string; key: string; legacy: string }> {
  const key = `deposit:test:${railRef}`;
  const amount = amt('10');
  const postedAt = new Date('2026-04-02T12:00:00.000Z');
  const txId = crypto.randomUUID();
  const meta = { rail: 'test', railRef };
  const [rail] = await database.sql<Array<{ id: string }>>`
    INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose, balance)
    VALUES ('treasury'::owner_type, 'rail:test', 'USDT', 'available'::account_kind, '', ${formatAmount(-amount)}::numeric)
    RETURNING id
  `;
  const [user] = await database.sql<Array<{ id: string }>>`
    INSERT INTO accounts (owner_type, owner_id, asset_id, kind, purpose, balance)
    VALUES ('user'::owner_type, ${USER}, 'USDT', 'available'::account_kind, '', ${formatAmount(amount)}::numeric)
    RETURNING id
  `;
  const legacy = hashTx(
    {
      id: txId,
      module: 'ledger',
      reason: 'deposit.credited',
      postedAt,
      entries: [
        {
          id: '',
          txId,
          accountId: rail!.id,
          assetId: 'USDT',
          direction: 'credit',
          amount,
          balanceAfter: -amount,
        },
        {
          id: '',
          txId,
          accountId: user!.id,
          assetId: 'USDT',
          direction: 'debit',
          amount,
          balanceAfter: amount,
        },
      ],
    },
    null,
  );
  const [inserted] = await database.sql<Array<{ seq: string }>>`
    INSERT INTO ledger_tx (id, idempotency_key, module, reason, meta, posted_at, hash, previous_hash)
    VALUES (
      ${txId}, ${key}, 'ledger', 'deposit.credited', ${database.sql.json(meta)}, ${postedAt}, ${legacy}, ${null}
    )
    RETURNING seq
  `;
  await database.sql`
    INSERT INTO ledger_entries (tx_id, account_id, asset_id, direction, amount, balance_after)
    VALUES (${txId}, ${rail!.id}, 'USDT', 'credit'::direction, ${formatAmount(amount)}::numeric, ${formatAmount(-amount)}::numeric)
  `;
  await database.sql`
    INSERT INTO ledger_entries (tx_id, account_id, asset_id, direction, amount, balance_after)
    VALUES (${txId}, ${user!.id}, 'USDT', 'debit'::direction, ${formatAmount(amount)}::numeric, ${formatAmount(amount)}::numeric)
  `;
  await database.sql`
    INSERT INTO ledger_posted_keys (idempotency_key, tx_id) VALUES (${key}, ${txId})
  `;
  await database.sql`UPDATE chain_tip SET hash = ${legacy}, seq = ${inserted!.seq} WHERE id = true`;
  return { id: txId, key, legacy };
}

function read0016(): string {
  const name = readdirSync(drizzleDir).find((f) => f.startsWith('0018_') && f.endsWith('.sql') && !f.endsWith('.down.sql'));
  if (!name) throw new Error('0016 is not in drizzle/');
  return readFileSync(join(drizzleDir, name), 'utf8');
}

describe('a legacy short digest cannot launder a rewritten key or meta', () => {
  let adminUrl = '';
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDb | undefined;
  let engine: PostgresLedger;
  const opened: TestDb[] = [];

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminUrl = admin.url;
    adminStop = admin.stop;
    db = await createTestDb({ service: 'ledger_txhash_short', url: admin.url, migrations });
    opened.push(db);
    engine = new PostgresLedger(db.sql);
  }, 120_000);

  afterAll(async () => {
    await Promise.all(opened.map((openedDb) => openedDb.drop()));
    await adminStop();
  }, 30_000);

  it('a legacy short digest does not launder a rewritten key or meta', async () => {
    if (!db) throw new Error('H8a: test db not opened');

    const first = await engine.post(
      recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('10'), rail: 'test', railRef: 'bind-short' }),
    );
    expect(await verifyChain(db.sql)).toMatchObject({ ok: true });
    expect(formatAmount((await engine.balance(userAvailable(USER, 'USDT'))).amount)).toBe('10');

    const legacy = await legacyShortDigest(db.sql, first.id);
    await db.sql`ALTER TABLE ledger_tx DISABLE TRIGGER ledger_tx_key_immutable`;
    await db.sql`
      UPDATE ledger_tx
         SET idempotency_key = ${'rewritten-short-key'}, hash = ${legacy}
       WHERE id = ${first.id}
    `;
    const broken = await verifyChain(db.sql);
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.brokenAt).toBe(first.id);

    await expect(
      engine.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('10'), rail: 'test', railRef: 'bind-short' })),
    ).rejects.toBeTruthy();
    expect(formatAmount((await engine.balance(userAvailable(USER, 'USDT'))).amount)).toBe('10');
    const rows = await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM ledger_tx`;
    expect(rows[0]?.n).toBe('1');

    const historical = await createTestDb({ service: 'ledger_txhash_hist', url: adminUrl, migrations: priorMigrations });
    opened.push(historical);
    const histEngine = new PostgresLedger(historical.sql);
    const hist = await insertHistoricalDeposit(historical, 'bind-hist');
    await historical.sql.unsafe(rewriteSchemaSql(read0016(), 'ledger', historical.schema));
    expect(await verifyChain(historical.sql)).toMatchObject({ ok: true });
    const [claim] = await historical.sql<
      Array<{ idempotency_key: string; posted_hash: string; posted_meta: { rail?: string; railRef?: string } }>
    >`
      SELECT idempotency_key, posted_hash, posted_meta FROM ledger_posted_keys WHERE tx_id = ${hist.id}
    `;
    expect(claim?.idempotency_key).toBe(hist.key);
    expect(claim?.posted_hash).toBe(hist.legacy);
    expect(claim?.posted_meta).toMatchObject({ rail: 'test', railRef: 'bind-hist' });

    await historical.sql`ALTER TABLE ledger_tx DISABLE TRIGGER ledger_tx_key_immutable`;
    await historical.sql`UPDATE ledger_tx SET idempotency_key = ${'rewritten-hist-key'} WHERE id = ${hist.id}`;
    const histBroken = await verifyChain(historical.sql);
    expect(histBroken.ok).toBe(false);
    if (!histBroken.ok) expect(histBroken.brokenAt).toBe(hist.id);
    await expect(
      histEngine.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('10'), rail: 'test', railRef: 'bind-hist' })),
    ).rejects.toBeTruthy();
    expect(formatAmount((await histEngine.balance(userAvailable(USER, 'USDT'))).amount)).toBe('10');
    const histRows = await historical.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM ledger_tx`;
    expect(histRows[0]?.n).toBe('1');

    const metaDb = await createTestDb({ service: 'ledger_txhash_meta', url: adminUrl, migrations: priorMigrations });
    opened.push(metaDb);
    const metaEngine = new PostgresLedger(metaDb.sql);
    const metaRow = await insertHistoricalDeposit(metaDb, 'bind-meta');
    await metaDb.sql.unsafe(rewriteSchemaSql(read0016(), 'ledger', metaDb.schema));
    expect(await verifyChain(metaDb.sql)).toMatchObject({ ok: true });
    await metaDb.sql`ALTER TABLE ledger_tx DISABLE TRIGGER ledger_tx_key_immutable`;
    await metaDb.sql`
      UPDATE ledger_tx
         SET meta = ${metaDb.sql.json({ rail: 'swapped' })}, hash = ${metaRow.legacy}
       WHERE id = ${metaRow.id}
    `;
    const metaBroken = await verifyChain(metaDb.sql);
    expect(metaBroken.ok).toBe(false);
    if (!metaBroken.ok) expect(metaBroken.brokenAt).toBe(metaRow.id);
    await expect(
      metaEngine.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('10'), rail: 'test', railRef: 'bind-meta' })),
    ).rejects.toMatchObject({ code: 'ledger.posted_claim_mismatch' });
    expect(formatAmount((await metaEngine.balance(userAvailable(USER, 'USDT'))).amount)).toBe('10');
    const metaRows = await metaDb.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM ledger_tx`;
    expect(metaRows[0]?.n).toBe('1');
  });
});

describe('receipt and chain-tip identity use the immutable posted claim', () => {
  let db: TestDb;
  let stop: () => Promise<void> = async () => undefined;
  let engine: PostgresLedger;
  beforeAll(async () => {
    const admin = await openH8aAdmin();
    stop = admin.stop;
    db = await createTestDb({ service: 'ledger_claim_receipt', url: admin.url, migrations });
    engine = new PostgresLedger(db.sql);
  });
  afterAll(async () => {
    await db?.drop();
    await stop();
  });

  it('refuses changed receipt metadata instead of returning journal bytes that contradict the claim', async () => {
    const request = recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('1'), rail: 'test', railRef: 'receipt-proof' });
    const tx = await engine.post(request);
    await db.sql`ALTER TABLE ledger_tx DISABLE TRIGGER ledger_tx_key_immutable`;
    await db.sql`UPDATE ledger_tx SET meta = ${db.sql.json({ forged: 'metadata' })} WHERE id = ${tx.id}`;
    await expect(engine.getTxByKey(request.idempotencyKey)).rejects.toMatchObject({ code: 'ledger.posted_claim_mismatch' });
    await expect(engine.getTx(tx.id)).rejects.toMatchObject({ code: 'ledger.posted_claim_mismatch' });
    await expect(engine.post(request)).rejects.toMatchObject({ code: 'ledger.posted_claim_mismatch' });
    expect(formatAmount((await engine.balance(userAvailable(USER, 'USDT'))).amount)).toBe('1');
    await db.sql`UPDATE ledger_tx SET meta = ${db.sql.json({ rail: 'test', railRef: 'receipt-proof' })} WHERE id = ${tx.id}`;
    await db.sql`ALTER TABLE ledger_tx ENABLE TRIGGER ledger_tx_key_immutable`;
  });

  it('refuses a second posted key for the same journal movement', async () => {
    const request = recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('1'), rail: 'test', railRef: 'claim-unique' });
    const tx = await engine.post(request);
    await expect(
      db.sql`INSERT INTO ledger_posted_keys(idempotency_key, tx_id, posted_hash, posted_meta) VALUES ('another-claim', ${tx.id}, ${tx.hash}, ${db.sql.json({ rail: 'test', railRef: 'claim-unique' })})`,
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('refuses a chain tip whose hash matches but whose sequence does not name the last posted row', async () => {
    expect(await verifyChain(db.sql)).toMatchObject({ ok: true });
    await db.sql`UPDATE chain_tip SET seq = seq + 1 WHERE id = true`;
    expect(await verifyChain(db.sql)).toMatchObject({ ok: false });
    await db.sql`UPDATE chain_tip SET seq = seq - 1 WHERE id = true`;
  });
});
