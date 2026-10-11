import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * L1229 — market.purchases status lock.
 *
 * Admin URL is the maintenance database. Each run creates its own database
 * (never intafaced_test) and applies the svc-market ups, including 0005 when
 * that file is present. The assertions are the post-lock predicates, so this
 * file fails on 0002's one-directional CHECKs and passes once 0005 is applied.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL?.trim();
if (!ADMIN_URL) throw new Error('Market native migration tests require an isolated TEST_DATABASE_URL');
const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');

const VENDOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VENDOR_USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LISTING = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const BUYER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SETTLED_AT = '2026-01-15T00:00:00.000Z';

const database = `l1229_purchase_lock_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;

let admin: postgres.Sql | undefined;
let sql: postgres.Sql;

async function expectCheckViolation(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
    expect(code).toBe('23514');
    return;
  }
  throw new Error('expected check_violation (23514)');
}

async function insertPurchase(fields: {
  status?: 'pending' | 'settled' | 'rejected';
  ledgerTxId?: string | null;
  settledAt?: string | null;
  rejectionCode?: string | null;
}): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO market.purchases (
      id, listing_id, buyer_id, vendor_id, vendor_user_id,
      asset_id, price, commission_bps, status,
      ledger_tx_id, settled_at, rejection_code
    ) VALUES (
      ${id},
      ${LISTING},
      ${BUYER},
      ${VENDOR},
      ${VENDOR_USER},
      'USDT',
      ${'10'}::numeric,
      500,
      ${fields.status ?? 'pending'},
      ${fields.ledgerTxId ?? null},
      ${fields.settledAt ?? null}::timestamptz,
      ${fields.rejectionCode ?? null}
    )
  `;
  return id;
}

describe('market.purchases status lock (L1229)', () => {
  beforeAll(async () => {
    expect(database).not.toBe('intafaced_test');
    expect(database.includes('intafaced_test')).toBe(false);

    const names = readdirSync(drizzle)
      .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
      .sort();
    console.log(`purchase-status-lock migrations: ${names.join(', ')}`);

    admin = postgres(ADMIN_URL, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`CREATE DATABASE "${database}"`);

    const target = new URL(ADMIN_URL);
    target.pathname = `/${database}`;
    sql = postgres(target.toString(), {
      max: 1,
      onnotice: () => undefined,
    });
    const [who] = await sql<Array<{ db: string }>>`SELECT current_database() AS db`;
    expect(who?.db).toBe(database);

    await sql.unsafe('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');
    await sql.unsafe('CREATE SCHEMA IF NOT EXISTS "market"');
    for (const name of names) {
      await sql.unsafe(readFileSync(join(drizzle, name), 'utf8'));
    }

    await sql`
      INSERT INTO market.vendors (id, user_id, display_name, description, status)
      VALUES (${VENDOR}, ${VENDOR_USER}, 'Acme', 'Sells bots', 'approved')
    `;
    await sql`
      INSERT INTO market.listings (
        id, vendor_id, title, description, offer_type, asset_id, price, status
      ) VALUES (
        ${LISTING}, ${VENDOR}, 'Bot', 'A bot', 'one_time', 'USDT', ${'10'}::numeric, 'active'
      )
    `;
  }, 60_000);

  beforeEach(async () => {
    await sql`TRUNCATE market.purchases RESTART IDENTITY CASCADE`;
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    if (admin && database) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    }
    await admin?.end({ timeout: 5 });
  }, 30_000);

  it('refuses a pending row that already points at a ledger transaction', async () => {
    await expectCheckViolation(() => insertPurchase({ ledgerTxId: randomUUID() }));
  });

  it('refuses a pending row with settled_at set', async () => {
    await expectCheckViolation(() => insertPurchase({ settledAt: SETTLED_AT }));
  });

  it('refuses a pending row with a rejection code', async () => {
    await expectCheckViolation(() => insertPurchase({ rejectionCode: 'market.insufficient_funds' }));
  });

  it('refuses writing ledger_tx_id onto a pending row without settling', async () => {
    const id = await insertPurchase({});
    await expectCheckViolation(() => sql`UPDATE market.purchases SET ledger_tx_id = ${randomUUID()} WHERE id = ${id}`);
  });

  it('refuses a settled row that still carries a rejection code', async () => {
    await expectCheckViolation(() =>
      insertPurchase({
        status: 'settled',
        ledgerTxId: randomUUID(),
        settledAt: SETTLED_AT,
        rejectionCode: 'market.insufficient_funds',
      }),
    );
  });

  it('refuses a rejected row that still points at a ledger transaction', async () => {
    await expectCheckViolation(() =>
      insertPurchase({
        status: 'rejected',
        rejectionCode: 'market.insufficient_funds',
        ledgerTxId: randomUUID(),
        settledAt: SETTLED_AT,
      }),
    );
  });

  it('lets a pending row become settled or rejected in one update', async () => {
    const settleId = await insertPurchase({});
    const ledgerTxId = randomUUID();
    await sql`
      UPDATE market.purchases
         SET status = 'settled',
             ledger_tx_id = ${ledgerTxId},
             settled_at = ${SETTLED_AT}::timestamptz,
             rejection_code = NULL
       WHERE id = ${settleId}
         AND status = 'pending'
    `;
    const [settled] = await sql<Array<{ status: string; ledger_tx_id: string; rejection_code: string | null }>>`
      SELECT status, ledger_tx_id, rejection_code FROM market.purchases WHERE id = ${settleId}
    `;
    expect(settled?.status).toBe('settled');
    expect(settled?.ledger_tx_id).toBe(ledgerTxId);
    expect(settled?.rejection_code).toBeNull();

    const rejectId = await insertPurchase({});
    await sql`
      UPDATE market.purchases
         SET status = 'rejected',
             rejection_code = 'market.insufficient_funds',
             ledger_tx_id = NULL,
             settled_at = NULL
       WHERE id = ${rejectId}
         AND status = 'pending'
    `;
    const [rejected] = await sql<Array<{ status: string; ledger_tx_id: string | null; settled_at: Date | null }>>`
      SELECT status, ledger_tx_id, settled_at FROM market.purchases WHERE id = ${rejectId}
    `;
    expect(rejected?.status).toBe('rejected');
    expect(rejected?.ledger_tx_id).toBeNull();
    expect(rejected?.settled_at).toBeNull();
  });

  it('refuses rewriting a settled purchase as rejected', async () => {
    const id = await insertPurchase({
      status: 'settled',
      ledgerTxId: randomUUID(),
      settledAt: SETTLED_AT,
    });
    await expectCheckViolation(
      () => sql`
        UPDATE market.purchases
           SET status = 'rejected',
               rejection_code = 'market.rewritten',
               ledger_tx_id = NULL,
               settled_at = NULL
         WHERE id = ${id}
      `,
    );
  });

  it('refuses rewriting a rejected purchase as settled', async () => {
    const id = await insertPurchase({
      status: 'rejected',
      rejectionCode: 'market.insufficient_funds',
    });
    await expectCheckViolation(
      () => sql`
        UPDATE market.purchases
           SET status = 'settled',
               rejection_code = NULL,
               ledger_tx_id = ${randomUUID()},
               settled_at = ${SETTLED_AT}::timestamptz
         WHERE id = ${id}
      `,
    );
  });

  it('refuses moving a settled purchase back to pending', async () => {
    const id = await insertPurchase({
      status: 'settled',
      ledgerTxId: randomUUID(),
      settledAt: SETTLED_AT,
    });
    await expectCheckViolation(
      () => sql`
        UPDATE market.purchases
           SET status = 'pending',
               ledger_tx_id = NULL,
               settled_at = NULL,
               rejection_code = NULL
         WHERE id = ${id}
      `,
    );
  });

  it('refuses clearing or replacing a settled ledger_tx_id', async () => {
    const original = randomUUID();
    const id = await insertPurchase({
      status: 'settled',
      ledgerTxId: original,
      settledAt: SETTLED_AT,
    });
    await expectCheckViolation(() => sql`UPDATE market.purchases SET ledger_tx_id = NULL WHERE id = ${id}`);
    await expectCheckViolation(() => sql`UPDATE market.purchases SET ledger_tx_id = ${randomUUID()} WHERE id = ${id}`);
    const [row] = await sql<Array<{ ledger_tx_id: string }>>`
      SELECT ledger_tx_id FROM market.purchases WHERE id = ${id}
    `;
    expect(row?.ledger_tx_id).toBe(original);
  });

  it('still stamps access_until on a settled row', async () => {
    const id = await insertPurchase({
      status: 'settled',
      ledgerTxId: randomUUID(),
      settledAt: SETTLED_AT,
    });
    const until = '2026-02-01T00:00:00.000Z';
    await sql`
      UPDATE market.purchases
         SET access_until = ${until}::timestamptz
       WHERE id = ${id}
    `;
    const [row] = await sql<Array<{ status: string; access_until: Date }>>`
      SELECT status, access_until FROM market.purchases WHERE id = ${id}
    `;
    expect(row?.status).toBe('settled');
    expect(row?.access_until.toISOString()).toBe(until);
  });
});
