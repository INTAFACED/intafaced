import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';

/**
 * VOIDED MEANS NO LOCK EVER HAPPENED.
 *
 * `p2p_trades_escrow_timestamp_ck` passes when `escrowed_at` is set even if
 * `resolution` is `voided`, and `cancelled` + `voided` is allowed by
 * `p2p_trades_resolution_matches_status_ck`. `settleOnce` posts nothing for
 * `voided` and then stamps `settled_at`, so an escrowed trade can be voided
 * and the seller's escrow stays in the per-trade escrow account.
 *
 * The service never writes this combination. A psql session, a migration, or
 * the next writer does not go through the service. This suite is raw SQL
 * against the schema those writers hit.
 *
 * Amounts below are decimal strings. A JavaScript number is not a balance.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzle, file), 'utf8'));

const SELLER = '11111111-1111-4111-8111-111111111111';
const BUYER = '22222222-2222-4222-8222-222222222222';
const OFFER = '00000000-0000-4000-8000-0000000000f0';
const TRADE = '00000000-0000-4000-8000-000000000303';
/** A second trade that never reaches escrow. Void stays legal for this one. */
const UNESCROWED = '00000000-0000-4000-8000-000000000304';

/** The figure escrowLock moved. Not derived. */
const ORIGINAL_AMOUNT = '250.500000000000000000';
const PRICE = '1.000000000000000000';
const FIAT_AMOUNT = '250.500000000000000000';

const H8A_IMAGE = 'postgres:16-alpine';

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
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
      `svc-p2p void-requires-no-escrow is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('a voided trade cannot already be escrowed', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'p2p', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  beforeEach(async () => {
    await sql`TRUNCATE p2p.p2p_trades, p2p.offers RESTART IDENTITY CASCADE`;
    await sql`
      INSERT INTO p2p.offers (
        id, maker_id, side, asset, fiat_currency, price_type, price,
        min_amt, max_amt, total_amt, remaining_amt, methods
      ) VALUES (
        ${OFFER}, ${SELLER}, 'sell', 'USDT', 'USD', 'fixed',
        ${PRICE}::numeric, ${'10.000000000000000000'}::numeric,
        ${'500.000000000000000000'}::numeric, ${'500.000000000000000000'}::numeric,
        ${'249.500000000000000000'}::numeric, '["sepa"]'::jsonb
      )
    `;
    await sql`
      INSERT INTO p2p.p2p_trades (
        id, offer_id, taker_id, maker_id, seller_id, buyer_id, asset, fiat_currency,
        amount, price, fiat_amount, method, status, deadline_at, escrowed_at
      ) VALUES (
        ${TRADE}, ${OFFER}, ${BUYER}, ${SELLER}, ${SELLER}, ${BUYER}, 'USDT', 'USD',
        ${ORIGINAL_AMOUNT}::numeric, ${PRICE}::numeric, ${FIAT_AMOUNT}::numeric,
        'sepa', 'escrowed', now() + interval '15 minutes', now()
      )
    `;
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  it('refuses to void a trade whose escrowed_at is set and leaves the locked amount', async () => {
    let refusal: string | null = null;
    try {
      await sql`
        UPDATE p2p.p2p_trades
           SET status = 'cancelled',
               resolution = 'voided',
               resolved_at = now(),
               deadline_at = NULL
         WHERE id = ${TRADE}
      `;
    } catch (err) {
      refusal = err instanceof Error ? err.message : String(err);
    }

    expect(refusal ?? 'UPDATE was allowed').toMatch(/unresolved escrow lock attempts cannot be voided/);

    const rows = await sql<
      Array<{
        status: string;
        resolution: string | null;
        amount: string;
        escrow_amount: string | null;
        escrowed_at: Date | null;
      }>
    >`
      SELECT status,
             resolution,
             amount::text AS amount,
             escrow_amount::text AS escrow_amount,
             escrowed_at
        FROM p2p.p2p_trades
       WHERE id = ${TRADE}
    `;
    const row = rows[0];
    expect(row?.status).toBe('escrowed');
    expect(row?.resolution).toBeNull();
    expect(row?.escrowed_at).not.toBeNull();
    expect(row?.amount).toBe(ORIGINAL_AMOUNT);
    expect(row?.escrow_amount).toBe(ORIGINAL_AMOUNT);
  });

  it('refuses a void that clears escrowed_at in the same statement and keeps the locked amount', async () => {
    let refusal: string | null = null;
    try {
      await sql`
        UPDATE p2p.p2p_trades
           SET status = 'cancelled',
               resolution = 'voided',
               resolved_at = now(),
               deadline_at = NULL,
               escrowed_at = NULL
         WHERE id = ${TRADE}
      `;
    } catch (err) {
      refusal = err instanceof Error ? err.message : String(err);
    }

    expect(refusal ?? 'UPDATE was allowed').toMatch(/unresolved escrow lock attempts cannot be voided/);

    const rows = await sql<Array<{ amount: string; escrow_amount: string | null; escrowed_at: Date | null; resolution: string | null }>>`
      SELECT amount::text AS amount,
             escrow_amount::text AS escrow_amount,
             escrowed_at,
             resolution
        FROM p2p.p2p_trades
       WHERE id = ${TRADE}
    `;
    expect(rows[0]?.resolution).toBeNull();
    expect(rows[0]?.escrowed_at).not.toBeNull();
    expect(rows[0]?.amount).toBe(ORIGINAL_AMOUNT);
    expect(rows[0]?.escrow_amount).toBe(ORIGINAL_AMOUNT);
  });

  it('refuses a void after an earlier statement cleared escrowed_at', async () => {
    let cleared: string | null = null;
    try {
      await sql`
        UPDATE p2p.p2p_trades
           SET status = 'created',
               escrowed_at = NULL,
               deadline_at = now() + interval '15 minutes'
         WHERE id = ${TRADE}
      `;
    } catch (err) {
      cleared = err instanceof Error ? err.message : String(err);
    }

    expect(cleared ?? 'UPDATE was allowed').toMatch(/escrow stamp cannot change or be cleared/);

    let refusal: string | null = null;
    try {
      await sql`
        UPDATE p2p.p2p_trades
           SET status = 'cancelled',
               resolution = 'voided',
               resolved_at = now(),
               deadline_at = NULL
         WHERE id = ${TRADE}
      `;
    } catch (err) {
      refusal = err instanceof Error ? err.message : String(err);
    }

    expect(refusal ?? 'UPDATE was allowed').toMatch(/unresolved escrow lock attempts cannot be voided/);

    const rows = await sql<Array<{ amount: string; escrow_amount: string | null; resolution: string | null }>>`
      SELECT amount::text AS amount,
             escrow_amount::text AS escrow_amount,
             resolution
        FROM p2p.p2p_trades
       WHERE id = ${TRADE}
    `;
    expect(rows[0]?.resolution).toBeNull();
    expect(rows[0]?.amount).toBe(ORIGINAL_AMOUNT);
    expect(rows[0]?.escrow_amount).toBe(ORIGINAL_AMOUNT);
  });

  it('allows void when escrowed_at and escrow_amount were never set', async () => {
    await sql`
      INSERT INTO p2p.p2p_trades (
        id, offer_id, taker_id, maker_id, seller_id, buyer_id, asset, fiat_currency,
        amount, price, fiat_amount, method, status, deadline_at
      ) VALUES (
        ${UNESCROWED}, ${OFFER}, ${BUYER}, ${SELLER}, ${SELLER}, ${BUYER}, 'USDT', 'USD',
        ${ORIGINAL_AMOUNT}::numeric, ${PRICE}::numeric, ${FIAT_AMOUNT}::numeric,
        'sepa', 'created', now() + interval '15 minutes'
      )
    `;

    await sql`
      UPDATE p2p.p2p_trades
         SET status = 'cancelled',
             resolution = 'voided',
             resolved_at = now(),
             deadline_at = NULL
       WHERE id = ${UNESCROWED}
    `;

    const rows = await sql<Array<{ resolution: string | null; amount: string; escrow_amount: string | null; escrowed_at: Date | null }>>`
      SELECT resolution,
             amount::text AS amount,
             escrow_amount::text AS escrow_amount,
             escrowed_at
        FROM p2p.p2p_trades
       WHERE id = ${UNESCROWED}
    `;
    expect(rows[0]?.resolution).toBe('voided');
    expect(rows[0]?.escrowed_at).toBeNull();
    expect(rows[0]?.escrow_amount).toBeNull();
    expect(rows[0]?.amount).toBe(ORIGINAL_AMOUNT);
  });

  it('allows refund of an escrowed trade and leaves the locked amount', async () => {
    await sql`
      UPDATE p2p.p2p_trades
         SET status = 'cancelled',
             resolution = 'refunded',
             resolved_at = now(),
             deadline_at = NULL
       WHERE id = ${TRADE}
    `;

    const rows = await sql<Array<{ resolution: string | null; amount: string; escrow_amount: string | null; escrowed_at: Date | null }>>`
      SELECT resolution,
             amount::text AS amount,
             escrow_amount::text AS escrow_amount,
             escrowed_at
        FROM p2p.p2p_trades
       WHERE id = ${TRADE}
    `;
    expect(rows[0]?.resolution).toBe('refunded');
    expect(rows[0]?.escrowed_at).not.toBeNull();
    expect(rows[0]?.amount).toBe(ORIGINAL_AMOUNT);
    expect(rows[0]?.escrow_amount).toBe(ORIGINAL_AMOUNT);
  });
});
