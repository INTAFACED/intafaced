import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * L1231 — purchase access window and period snapshot.
 *
 * Admin URL is the maintenance database. Each run creates its own database
 * (never intafaced_test) and applies the svc-market ups, including 0007 when
 * that file is present. Pending and rejected rows can store access_until on
 * 0003. These assertions fail there and pass once 0007 is applied.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL?.trim();
if (!ADMIN_URL) throw new Error('Market native migration tests require an isolated TEST_DATABASE_URL');
const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');

const VENDOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VENDOR_USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ONE_LISTING = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SUB_LISTING = 'c1c1c1c1-c1c1-41c1-81c1-c1c1c1c1c1c1';
const BUYER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PERIOD = 3600;
const FUTURE = '2026-12-01T00:00:00.000Z';
const SETTLED_AT = '2026-01-15T00:00:00.000Z';

const database = `l1231_access_window_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;

let admin: postgres.Sql | undefined;
let sql: postgres.Sql;

async function expectSqlState(run: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await run();
  } catch (err) {
    const got = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
    expect(got).toBe(code);
    return;
  }
  throw new Error(`expected sqlstate ${code}`);
}

async function insertPurchase(fields: {
  listingId?: string;
  status?: 'pending' | 'settled' | 'rejected';
  ledgerTxId?: string | null;
  settledAt?: string | null;
  rejectionCode?: string | null;
  accessUntil?: string | null;
  /** Copy listings.period_seconds. Absent on the access-window inserts. */
  copyPeriod?: boolean;
  /** Explicit purchase period. Absent leaves the column out of the insert. */
  periodSeconds?: number | null;
}): Promise<string> {
  const id = randomUUID();
  const listingId = fields.listingId ?? ONE_LISTING;
  const status = fields.status ?? 'pending';
  const ledgerTxId = fields.ledgerTxId ?? null;
  const settledAt = fields.settledAt ?? null;
  const rejectionCode = fields.rejectionCode ?? null;
  const accessUntil = fields.accessUntil ?? null;
  if (fields.copyPeriod) {
    await sql`
      INSERT INTO market.purchases (
        id, listing_id, buyer_id, vendor_id, vendor_user_id,
        asset_id, price, commission_bps, period_seconds, status,
        ledger_tx_id, settled_at, rejection_code, access_until
      )
      SELECT
        ${id}, l.id, ${BUYER}, l.vendor_id, v.user_id, l.asset_id, l.price,
        500, l.period_seconds, ${status}, ${ledgerTxId},
        ${settledAt}::timestamptz, ${rejectionCode}, ${accessUntil}::timestamptz
      FROM market.listings l
      JOIN market.vendors v ON v.id = l.vendor_id
      WHERE l.id = ${listingId}
    `;
    return id;
  }
  if (fields.periodSeconds !== undefined) {
    await sql`
      INSERT INTO market.purchases (
        id, listing_id, buyer_id, vendor_id, vendor_user_id,
        asset_id, price, commission_bps, period_seconds, status,
        ledger_tx_id, settled_at, rejection_code, access_until
      )
      SELECT
        ${id}, l.id, ${BUYER}, l.vendor_id, v.user_id, l.asset_id, l.price,
        500, ${fields.periodSeconds}, ${status}, ${ledgerTxId},
        ${settledAt}::timestamptz, ${rejectionCode}, ${accessUntil}::timestamptz
      FROM market.listings l
      JOIN market.vendors v ON v.id = l.vendor_id
      WHERE l.id = ${listingId}
    `;
    return id;
  }
  await sql`
    INSERT INTO market.purchases (
      id, listing_id, buyer_id, vendor_id, vendor_user_id,
      asset_id, price, commission_bps, status,
      ledger_tx_id, settled_at, rejection_code, access_until
    )
    SELECT
      ${id}, l.id, ${BUYER}, l.vendor_id, v.user_id, l.asset_id, l.price,
      500, ${status}, ${ledgerTxId},
      ${settledAt}::timestamptz, ${rejectionCode}, ${accessUntil}::timestamptz
    FROM market.listings l
    JOIN market.vendors v ON v.id = l.vendor_id
    WHERE l.id = ${listingId}
  `;
  return id;
}

async function accessIndexPredicate(): Promise<string> {
  const [row] = await sql<Array<{ pred: string | null }>>`
    SELECT pg_get_expr(i.indpred, i.indrelid) AS pred
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'market'
       AND c.relname = 'purchases_subscription_access_idx'
  `;
  return (row?.pred ?? '')
    .toLowerCase()
    .replace(/::text/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('market.purchases access window (L1231)', () => {
  beforeAll(async () => {
    expect(database).not.toBe('intafaced_test');
    expect(database.includes('intafaced_test')).toBe(false);

    const names = readdirSync(drizzle)
      .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
      .sort();
    console.log(`purchase-access-window migrations: ${names.join(', ')}`);

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
        id, vendor_id, title, description, offer_type, asset_id, price, period_seconds, status
      ) VALUES
        (${ONE_LISTING}, ${VENDOR}, 'Bot', 'A bot', 'one_time', 'USDT', ${'10'}::numeric, NULL, 'active'),
        (${SUB_LISTING}, ${VENDOR}, 'Feed', 'Hourly', 'subscription', 'USDT', ${'10'}::numeric, ${PERIOD}, 'active')
    `;
  }, 60_000);

  beforeEach(async () => {
    await sql`TRUNCATE market.purchases RESTART IDENTITY CASCADE`;
    await sql`UPDATE market.listings SET period_seconds = NULL WHERE id = ${ONE_LISTING}`;
    await sql`UPDATE market.listings SET period_seconds = ${PERIOD} WHERE id = ${SUB_LISTING}`;
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    if (admin && database) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    }
    await admin?.end({ timeout: 5 });
  }, 30_000);

  it('refuses a pending purchase that stores a future access_until', async () => {
    await expectSqlState(() => insertPurchase({ status: 'pending', accessUntil: FUTURE }), '23514');
  });

  it('refuses a rejected purchase that stores a future access_until', async () => {
    await expectSqlState(
      () =>
        insertPurchase({
          status: 'rejected',
          rejectionCode: 'market.insufficient_funds',
          accessUntil: FUTURE,
        }),
      '23514',
    );
  });

  it('refuses stamping access_until onto a pending or rejected row', async () => {
    const pending = await insertPurchase({ status: 'pending' });
    const rejected = await insertPurchase({
      status: 'rejected',
      rejectionCode: 'market.insufficient_funds',
    });
    await expectSqlState(() => sql`UPDATE market.purchases SET access_until = ${FUTURE}::timestamptz WHERE id = ${pending}`, '23514');
    await expectSqlState(() => sql`UPDATE market.purchases SET access_until = ${FUTURE}::timestamptz WHERE id = ${rejected}`, '23514');
  });

  it('stores access_until only when the purchase is settled and has a ledger id', async () => {
    const id = await insertPurchase({
      status: 'settled',
      ledgerTxId: randomUUID(),
      settledAt: SETTLED_AT,
      accessUntil: FUTURE,
    });
    const [row] = await sql<Array<{ status: string; ledger_tx_id: string; access_until: Date }>>`
      SELECT status, ledger_tx_id, access_until FROM market.purchases WHERE id = ${id}
    `;
    expect(row?.status).toBe('settled');
    expect(row?.ledger_tx_id).toBeTruthy();
    expect(row?.access_until.toISOString()).toBe(FUTURE);

    const open = await insertPurchase({
      status: 'settled',
      ledgerTxId: randomUUID(),
      settledAt: SETTLED_AT,
    });
    const [plain] = await sql<Array<{ access_until: Date | null }>>`
      SELECT access_until FROM market.purchases WHERE id = ${open}
    `;
    expect(plain?.access_until).toBeNull();
  });

  it('does not match a pending or rejected row from the access index', async () => {
    const pred = await accessIndexPredicate();
    expect(pred).toContain('access_until is not null');
    // A paid purchase: settled, or held and released (MC-market-02). Never pending, rejected or refunded.
    expect(pred).toContain("status = any (array['settled', 'held', 'released'])");
    expect(pred).not.toMatch(/pending|rejected|refunded/);
    expect(pred).toContain('ledger_tx_id is not null');

    await expectSqlState(() => insertPurchase({ status: 'pending', accessUntil: FUTURE }), '23514');
    await expectSqlState(
      () =>
        insertPurchase({
          status: 'rejected',
          rejectionCode: 'market.purchase_conflict',
          accessUntil: FUTURE,
        }),
      '23514',
    );
    const settled = await insertPurchase({
      status: 'settled',
      ledgerTxId: randomUUID(),
      settledAt: SETTLED_AT,
      accessUntil: FUTURE,
    });
    const [counts] = await sql<Array<{ pending_windows: number; rejected_windows: number; settled_windows: number }>>`
      SELECT
        count(*) FILTER (WHERE status = 'pending' AND access_until IS NOT NULL)::int AS pending_windows,
        count(*) FILTER (WHERE status = 'rejected' AND access_until IS NOT NULL)::int AS rejected_windows,
        count(*) FILTER (
          WHERE status = 'settled' AND ledger_tx_id IS NOT NULL AND access_until IS NOT NULL
        )::int AS settled_windows
      FROM market.purchases
    `;
    expect(counts?.pending_windows).toBe(0);
    expect(counts?.rejected_windows).toBe(0);
    expect(counts?.settled_windows).toBe(1);
    const [indexed] = await sql<Array<{ id: string }>>`
      SELECT id FROM market.purchases
       WHERE listing_id = ${ONE_LISTING}
         AND buyer_id = ${BUYER}
         AND access_until IS NOT NULL
         AND status = 'settled'
         AND ledger_tx_id IS NOT NULL
         AND id = ${settled}
    `;
    expect(indexed?.id).toBe(settled);
  });

  it('snapshots the listing period onto the purchase and ignores a later listing change', async () => {
    const id = await insertPurchase({ listingId: SUB_LISTING, status: 'pending', copyPeriod: true });
    const [claimed] = await sql<Array<{ period_seconds: number | null; access_until: Date | null }>>`
      SELECT period_seconds, access_until FROM market.purchases WHERE id = ${id}
    `;
    expect(claimed?.period_seconds).toBe(PERIOD);
    expect(claimed?.access_until).toBeNull();

    await sql`UPDATE market.listings SET period_seconds = ${PERIOD * 2} WHERE id = ${SUB_LISTING}`;
    const [after] = await sql<Array<{ purchase_period: number | null; listing_period: number | null }>>`
      SELECT p.period_seconds AS purchase_period, l.period_seconds AS listing_period
        FROM market.purchases p
        JOIN market.listings l ON l.id = p.listing_id
       WHERE p.id = ${id}
    `;
    expect(after?.listing_period).toBe(PERIOD * 2);
    expect(after?.purchase_period).toBe(PERIOD);
  });

  it('does not invent a period when the listing period is null', async () => {
    const id = await insertPurchase({ listingId: ONE_LISTING, status: 'pending', copyPeriod: true });
    const [row] = await sql<Array<{ period_seconds: number | null }>>`
      SELECT period_seconds FROM market.purchases WHERE id = ${id}
    `;
    expect(row?.period_seconds).toBeNull();
    expect(row?.period_seconds).not.toBe(2_592_000);

    const omitted = randomUUID();
    await sql`
      INSERT INTO market.purchases (
        id, listing_id, buyer_id, vendor_id, vendor_user_id,
        asset_id, price, commission_bps, status
      )
      SELECT ${omitted}, l.id, ${BUYER}, l.vendor_id, v.user_id, l.asset_id, l.price, 500, 'pending'
        FROM market.listings l
        JOIN market.vendors v ON v.id = l.vendor_id
       WHERE l.id = ${ONE_LISTING}
    `;
    const [plain] = await sql<Array<{ period_seconds: number | null }>>`
      SELECT period_seconds FROM market.purchases WHERE id = ${omitted}
    `;
    expect(plain?.period_seconds).toBeNull();
  });

  it('refuses a non-positive purchase period and a rewrite of the snapshot', async () => {
    await expectSqlState(() => insertPurchase({ listingId: SUB_LISTING, periodSeconds: 0 }), '23514');
    await expectSqlState(() => insertPurchase({ listingId: SUB_LISTING, periodSeconds: -1 }), '23514');
    const id = await insertPurchase({ listingId: SUB_LISTING, status: 'pending', copyPeriod: true });
    await expectSqlState(() => sql`UPDATE market.purchases SET period_seconds = ${PERIOD * 2} WHERE id = ${id}`, '23514');
    const [row] = await sql<Array<{ period_seconds: number | null }>>`
      SELECT period_seconds FROM market.purchases WHERE id = ${id}
    `;
    expect(row?.period_seconds).toBe(PERIOD);
  });

  it('copies period_seconds from the listing and writes access_until only on a paid path', () => {
    const src = readFileSync(join(here, 'commerce-service.ts'), 'utf8');
    const claim = src.slice(src.indexOf('private async claimPurchase'));
    expect(claim).toContain('l.period_seconds');
    expect(claim).not.toContain('access_until');
    expect(claim).not.toMatch(/COALESCE\s*\(\s*l\.period_seconds/i);

    const ensureStart = src.indexOf('private async ensureSubscriptionAccess');
    const ensureEnd = src.indexOf('private async maxAccessUntilExcluding');
    const ensure = src.slice(ensureStart, ensureEnd);
    expect(ensure).toContain('paidPeriodSeconds(purchase)');
    expect(ensure).not.toContain('requireSubscriptionPeriod(listing)');
    expect(ensure).not.toContain('listing.periodSeconds');
    expect(ensure).toMatch(
      /SET access_until = \$\{untilIso\}::timestamptz\s+WHERE id = \$\{purchase\.id\}\s+AND status IN \('settled', 'held', 'released'\)\s+AND ledger_tx_id IS NOT NULL\s+AND access_until IS NULL/,
    );
    expect(src).not.toContain('2592000');
    expect(src).not.toContain("interval '1 month'");
  });
});
