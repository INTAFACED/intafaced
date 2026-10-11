import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * L1230 — market.purchases payee and asset snapshot.
 *
 * Admin URL is the maintenance database. Each run creates its own database
 * (never intafaced_test) and applies the svc-market ups, including 0006 when
 * that file is present. The assertions are the snapshot predicates, so this
 * file fails on 0002's unbound columns and passes once 0006 is applied.
 */

const ADMIN_URL = process.env.TEST_DATABASE_URL?.trim();
if (!ADMIN_URL) throw new Error('Market native migration tests require an isolated TEST_DATABASE_URL');
const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');

const VENDOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const VENDOR_USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_VENDOR = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OTHER_USER = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const LISTING = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const BUYER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ASSET = 'USDT';
const ASSET_32 = 'A'.repeat(32);

const database = `l1230_purchase_snapshot_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;

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

async function insertPurchase(fields: { listingId?: string; vendorId?: string; vendorUserId?: string; assetId?: string }): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO market.purchases (
      id, listing_id, buyer_id, vendor_id, vendor_user_id,
      asset_id, price, commission_bps, status
    ) VALUES (
      ${id},
      ${fields.listingId ?? LISTING},
      ${BUYER},
      ${fields.vendorId ?? VENDOR},
      ${fields.vendorUserId ?? VENDOR_USER},
      ${fields.assetId ?? ASSET},
      ${'10'}::numeric,
      500,
      'pending'
    )
  `;
  return id;
}

describe('market.purchases payee and asset snapshot (L1230)', () => {
  beforeAll(async () => {
    expect(database).not.toBe('intafaced_test');
    expect(database.includes('intafaced_test')).toBe(false);

    const names = readdirSync(drizzle)
      .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
      .sort();
    console.log(`purchase-snapshot migrations: ${names.join(', ')}`);

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
      VALUES
        (${VENDOR}, ${VENDOR_USER}, 'Acme', 'Sells bots', 'approved'),
        (${OTHER_VENDOR}, ${OTHER_USER}, 'Other', 'Different shop', 'approved')
    `;
    await sql`
      INSERT INTO market.listings (
        id, vendor_id, title, description, offer_type, asset_id, price, status
      ) VALUES (
        ${LISTING}, ${VENDOR}, 'Bot', 'A bot', 'one_time', ${ASSET}, ${'10'}::numeric, 'active'
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

  it('stores the listing vendor, that vendor user, and the listing asset', async () => {
    const id = await insertPurchase({});
    const [row] = await sql<Array<{ vendor_ok: boolean; user_ok: boolean; asset_ok: boolean; asset_id: string }>>`
      SELECT p.vendor_id = l.vendor_id AS vendor_ok,
             p.vendor_user_id = v.user_id AS user_ok,
             p.asset_id = l.asset_id AS asset_ok,
             p.asset_id
        FROM market.purchases p
        JOIN market.listings l ON l.id = p.listing_id
        JOIN market.vendors v ON v.id = l.vendor_id
       WHERE p.id = ${id}
    `;
    expect(row?.vendor_ok).toBe(true);
    expect(row?.user_ok).toBe(true);
    expect(row?.asset_ok).toBe(true);
    expect(row?.asset_id).toBe(ASSET);
  });

  it('accepts a 32-character asset that matches the listing', async () => {
    const listingId = randomUUID();
    await sql`
      INSERT INTO market.listings (
        id, vendor_id, title, description, offer_type, asset_id, price, status
      ) VALUES (
        ${listingId}, ${VENDOR}, 'Wide', '32-char asset', 'one_time', ${ASSET_32}, ${'10'}::numeric, 'active'
      )
    `;
    const id = await insertPurchase({ listingId, assetId: ASSET_32 });
    const [row] = await sql<Array<{ asset_id: string }>>`
      SELECT asset_id FROM market.purchases WHERE id = ${id}
    `;
    expect(row?.asset_id).toBe(ASSET_32);
    expect(row?.asset_id.length).toBe(32);
  });

  it('refuses a purchase that names the listing but a different vendor', async () => {
    await expectSqlState(() => insertPurchase({ vendorId: OTHER_VENDOR, vendorUserId: OTHER_USER }), '23503');
  });

  it('refuses a purchase that pays a different user than the listing vendor', async () => {
    await expectSqlState(() => insertPurchase({ vendorUserId: OTHER_USER }), '23503');
  });

  it('refuses a purchase whose asset differs from the listing', async () => {
    await expectSqlState(() => insertPurchase({ assetId: 'ETH' }), '23503');
  });

  it('refuses a blank purchase asset', async () => {
    await expectSqlState(() => insertPurchase({ assetId: '' }), '23514');
  });

  it('refuses a whitespace purchase asset', async () => {
    await expectSqlState(() => insertPurchase({ assetId: '   ' }), '23514');
  });

  it('refuses a purchase asset longer than 32 characters', async () => {
    await expectSqlState(() => insertPurchase({ assetId: 'B'.repeat(33) }), '23514');
  });

  it('refuses rewriting the payee or the asset on a stored snapshot', async () => {
    const id = await insertPurchase({});
    await expectSqlState(() => sql`UPDATE market.purchases SET vendor_user_id = ${OTHER_USER} WHERE id = ${id}`, '23514');
    await expectSqlState(() => sql`UPDATE market.purchases SET asset_id = 'ETH' WHERE id = ${id}`, '23514');
    await expectSqlState(
      () => sql`UPDATE market.purchases SET vendor_id = ${OTHER_VENDOR}, vendor_user_id = ${OTHER_USER} WHERE id = ${id}`,
      '23514',
    );
    const [row] = await sql<Array<{ vendor_id: string; vendor_user_id: string; asset_id: string }>>`
      SELECT vendor_id, vendor_user_id, asset_id FROM market.purchases WHERE id = ${id}
    `;
    expect(row?.vendor_id).toBe(VENDOR);
    expect(row?.vendor_user_id).toBe(VENDOR_USER);
    expect(row?.asset_id).toBe(ASSET);
  });

  it('keeps the buyer, price, commission and purchase identity immutable', async () => {
    const id = await insertPurchase({});
    await expectSqlState(() => sql`UPDATE market.purchases SET buyer_id = ${OTHER_USER} WHERE id = ${id}`, '23514');
    await expectSqlState(() => sql`UPDATE market.purchases SET price = 20 WHERE id = ${id}`, '23514');
    await expectSqlState(() => sql`UPDATE market.purchases SET commission_bps = 1000 WHERE id = ${id}`, '23514');
    await expectSqlState(() => sql`UPDATE market.purchases SET id = ${randomUUID()} WHERE id = ${id}`, '23514');
    const [row] = await sql`SELECT buyer_id, price::text, commission_bps FROM market.purchases WHERE id = ${id}`;
    expect(row).toMatchObject({ buyer_id: BUYER, price: '10.000000000000000000', commission_bps: 500 });
  });
});
