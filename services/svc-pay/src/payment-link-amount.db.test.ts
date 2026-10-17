/**
 * payment_links.amount is a price only when a merchant set one.
 *
 * A null amount stays an open link. Zero, a negative price, an amount with no
 * currency, and a magnitude that will not fit numeric(38,18) — 20 digits before
 * the decimal and 18 after — are refused at insert. Amounts are decimal strings
 * on the wire. This file does not parse them as JS numbers.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { truncatePayForTest } from './payment-events-test-reset.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');

/** Every forward migration, so the amount check and later columns are both present. */
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

/** Largest magnitude numeric(38,18) can store: 20 nines, then 18. */
const FITS_NUMERIC_38_18 = '99999999999999999999.999999999999999999';
/** 10^20. One digit past that column. numeric(40,18) still accepts it. */
const OVERFLOWS_NUMERIC_38_18 = '100000000000000000000';

function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) {
    throw new Error('TEST_DATABASE_URL is unset; refusing to guess a database for payment link amounts');
  }
  return url;
}

/**
 * A fresh database on the given server, with the pay schema and these
 * migrations only. The name ends in `_test` so it cannot be the shared book.
 */
async function openPayDatabase(adminUrl: string, files: readonly string[]): Promise<{ sql: postgres.Sql; drop: () => Promise<void> }> {
  const admin = postgres(adminUrl, { max: 1, onnotice: () => undefined });
  const current = await admin<Array<{ db: string }>>`SELECT current_database() AS db`;
  const dbName = current[0]?.db ?? '';
  if (!dbName.endsWith('_test')) {
    await admin.end({ timeout: 0 });
    throw new Error(`refusing to migrate payment links on database ${dbName}`);
  }

  const database = `pay_l864_${process.pid}_${Math.random().toString(36).slice(2, 8)}_test`;
  await admin.unsafe(`CREATE DATABASE "${database}"`);
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  const sql = postgres(url.toString(), {
    max: 4,
    connection: { search_path: 'pay,public' },
    onnotice: () => undefined,
  });
  await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "pay"`);
  for (const migration of files) {
    await sql.unsafe(migration);
  }

  return {
    sql,
    drop: async () => {
      await sql.end({ timeout: 0 }).catch(() => undefined);
      await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => undefined);
      await admin.end({ timeout: 0 }).catch(() => undefined);
    },
  };
}

describe('payment link amount', () => {
  let sql!: postgres.Sql;
  let drop: (() => Promise<void>) | undefined;
  let merchantId = '';

  beforeAll(async () => {
    const opened = await openPayDatabase(testDatabaseUrl(), migrations);
    sql = opened.sql;
    drop = opened.drop;
  }, 120_000);

  beforeEach(async () => {
    await truncatePayForTest(sql, 'pay', 'TRUNCATE pay.payment_links, pay.merchants RESTART IDENTITY CASCADE');
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO pay.merchants (user_id) VALUES ('payment-link-amount') RETURNING id
    `;
    merchantId = rows[0]!.id;
  });

  afterAll(async () => {
    await drop?.();
  }, 30_000);

  async function insertLink(tokenHash: string, amount: string | null, currency: string | null): Promise<void> {
    await sql`
      INSERT INTO pay.payment_links (merchant_id, token_hash, token_prefix, label, amount, currency)
      VALUES (
        ${merchantId},
        ${tokenHash},
        'pl_amt',
        'amount probe',
        ${amount}::numeric,
        ${currency}
      )
    `;
  }

  async function stored(tokenHash: string): Promise<{ amount: string | null; currency: string | null } | undefined> {
    const rows = await sql<Array<{ amount: string | null; currency: string | null }>>`
      SELECT amount::text AS amount, currency
        FROM pay.payment_links
       WHERE token_hash = ${tokenHash}
    `;
    return rows[0];
  }

  it('refuses a zero amount', async () => {
    await expect(insertLink('zero', '0', 'USD')).rejects.toThrow();
    expect(await stored('zero')).toBeUndefined();
  });

  it('refuses a negative amount', async () => {
    await expect(insertLink('negative', '-1.50', 'USD')).rejects.toThrow();
    expect(await stored('negative')).toBeUndefined();
  });

  it('refuses an amount with no currency', async () => {
    await expect(insertLink('no-currency', '12.50', null)).rejects.toThrow();
    expect(await stored('no-currency')).toBeUndefined();
  });

  it('refuses an amount that cannot fit numeric(38,18)', async () => {
    await expect(insertLink('overflow', OVERFLOWS_NUMERIC_38_18, 'USD')).rejects.toThrow();
    expect(await stored('overflow')).toBeUndefined();
  });

  it('stores a null amount', async () => {
    await insertLink('open', null, null);
    expect(await stored('open')).toEqual({ amount: null, currency: null });
  });

  it('stores a positive amount that fits, with a currency', async () => {
    await insertLink('priced', '12.50', 'USD');
    expect(await stored('priced')).toEqual({ amount: '12.500000000000000000', currency: 'USD' });
  });

  it('stores the largest numeric(38,18) amount with a currency', async () => {
    await insertLink('ceiling', FITS_NUMERIC_38_18, 'USD');
    expect(await stored('ceiling')).toEqual({ amount: FITS_NUMERIC_38_18, currency: 'USD' });
  });
});
