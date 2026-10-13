import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';

/**
 * A RESOLVED DISPUTE'S RULING CANNOT CHANGE.
 *
 * `p2p_disputes_resolved_is_attributed_ck` (0000 lines 265–270) stays true when
 * `resolution` flips from `release` to `refund` while `status`, `moderator_id`,
 * and `resolved_at` stay populated. `p2p_disputes_evidence_append_only` returns
 * immediately when evidence is unchanged, so it does not freeze the ruling.
 * After the escrow has moved, that rewrite names the opposite party from the
 * one who was paid.
 *
 * The service refuses a second `resolveDispute`. A psql session does not. This
 * suite is raw SQL against the schema those writers hit.
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
const MODERATOR = '4a4b4c4d-4e4f-4a4b-8c4d-4e4f5a6b7c8d';
const OFFER = '00000000-0000-4000-8000-0000000000f0';
const TRADE = '00000000-0000-4000-8000-000000000304';
const REFUND_TRADE = '00000000-0000-4000-8000-000000000305';

/** The figure escrow locked and settlement paid. Not derived. */
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
      `svc-p2p dispute ruling freeze is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('a resolved dispute ruling cannot change', () => {
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
    await sql`TRUNCATE p2p.p2p_disputes, p2p.p2p_trades, p2p.offers RESTART IDENTITY CASCADE`;
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
        'sepa', 'disputed', now() + interval '7 days', now()
      )
    `;
    await sql`
      INSERT INTO p2p.p2p_disputes (trade_id, opened_by, deadline_at)
      VALUES (${TRADE}, ${BUYER}, now() + interval '7 days')
    `;
    await sql`
      UPDATE p2p.p2p_disputes
         SET status = 'resolved',
             moderator_id = ${MODERATOR},
             resolution = 'release',
             resolved_at = now()
       WHERE trade_id = ${TRADE}
    `;
    await sql`
      UPDATE p2p.p2p_trades
         SET status = 'released',
             resolution = 'released',
             resolved_at = now(),
             settled_at = now(),
             deadline_at = NULL
       WHERE id = ${TRADE}
    `;
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  it('refuses to rewrite release to refund after escrow moved and leaves the ruling and the locked amount', async () => {
    let refusal: string | null = null;
    try {
      await sql`
        UPDATE p2p.p2p_disputes
           SET resolution = 'refund'
         WHERE trade_id = ${TRADE}
      `;
    } catch (err) {
      refusal = err instanceof Error ? err.message : String(err);
    }

    expect(refusal ?? 'UPDATE was allowed').toMatch(/p2p_disputes_resolved_ruling_frozen/);

    const disputes = await sql<
      Array<{
        resolution: string | null;
        status: string;
        moderator_id: string | null;
        evidence: unknown;
      }>
    >`
      SELECT resolution::text AS resolution,
             status::text AS status,
             moderator_id,
             evidence
        FROM p2p.p2p_disputes
       WHERE trade_id = ${TRADE}
    `;
    expect(disputes).toHaveLength(1);
    expect(disputes[0]?.resolution).toBe('release');
    expect(disputes[0]?.status).toBe('resolved');
    expect(disputes[0]?.moderator_id).toBe(MODERATOR);
    expect(disputes[0]?.evidence).toEqual([]);

    const trades = await sql<
      Array<{ resolution: string | null; amount: string; escrow_amount: string | null }>
    >`
      SELECT resolution::text AS resolution,
             amount::text AS amount,
             escrow_amount::text AS escrow_amount
        FROM p2p.p2p_trades
       WHERE id = ${TRADE}
    `;
    expect(trades[0]?.resolution).toBe('released');
    expect(trades[0]?.amount).toBe(ORIGINAL_AMOUNT);
    expect(trades[0]?.escrow_amount).toBe(ORIGINAL_AMOUNT);

    await sql`
      UPDATE p2p.p2p_disputes
         SET resolution_notes = 'ruling stands'
       WHERE trade_id = ${TRADE}
    `;
    const noted = await sql<Array<{ resolution: string | null; resolution_notes: string | null }>>`
      SELECT resolution::text AS resolution, resolution_notes
        FROM p2p.p2p_disputes
       WHERE trade_id = ${TRADE}
    `;
    expect(noted[0]?.resolution).toBe('release');
    expect(noted[0]?.resolution_notes).toBe('ruling stands');
  });

  it('refuses to rewrite refund to release after escrow moved and leaves the ruling and the locked amount', async () => {
    await sql`
      INSERT INTO p2p.p2p_trades (
        id, offer_id, taker_id, maker_id, seller_id, buyer_id, asset, fiat_currency,
        amount, price, fiat_amount, method, status, deadline_at, escrowed_at
      ) VALUES (
        ${REFUND_TRADE}, ${OFFER}, ${BUYER}, ${SELLER}, ${SELLER}, ${BUYER}, 'USDT', 'USD',
        ${ORIGINAL_AMOUNT}::numeric, ${PRICE}::numeric, ${FIAT_AMOUNT}::numeric,
        'sepa', 'disputed', now() + interval '7 days', now()
      )
    `;
    await sql`
      INSERT INTO p2p.p2p_disputes (trade_id, opened_by, deadline_at)
      VALUES (${REFUND_TRADE}, ${BUYER}, now() + interval '7 days')
    `;
    await sql`
      UPDATE p2p.p2p_disputes
         SET status = 'resolved',
             moderator_id = ${MODERATOR},
             resolution = 'refund',
             resolved_at = now()
       WHERE trade_id = ${REFUND_TRADE}
    `;
    await sql`
      UPDATE p2p.p2p_trades
         SET status = 'cancelled',
             resolution = 'refunded',
             resolved_at = now(),
             settled_at = now(),
             deadline_at = NULL
       WHERE id = ${REFUND_TRADE}
    `;

    let refusal: string | null = null;
    try {
      await sql`
        UPDATE p2p.p2p_disputes
           SET resolution = 'release'
         WHERE trade_id = ${REFUND_TRADE}
      `;
    } catch (err) {
      refusal = err instanceof Error ? err.message : String(err);
    }

    expect(refusal ?? 'UPDATE was allowed').toMatch(/p2p_disputes_resolved_ruling_frozen/);

    const disputes = await sql<Array<{ resolution: string | null }>>`
      SELECT resolution::text AS resolution
        FROM p2p.p2p_disputes
       WHERE trade_id = ${REFUND_TRADE}
    `;
    expect(disputes).toHaveLength(1);
    expect(disputes[0]?.resolution).toBe('refund');

    const trades = await sql<Array<{ resolution: string | null; amount: string; escrow_amount: string | null }>>`
      SELECT resolution::text AS resolution,
             amount::text AS amount,
             escrow_amount::text AS escrow_amount
        FROM p2p.p2p_trades
       WHERE id = ${REFUND_TRADE}
    `;
    expect(trades[0]?.resolution).toBe('refunded');
    expect(trades[0]?.amount).toBe(ORIGINAL_AMOUNT);
    expect(trades[0]?.escrow_amount).toBe(ORIGINAL_AMOUNT);
  });

  it('refuses a ruling rewrite that also appends evidence', async () => {
    let refusal: string | null = null;
    try {
      await sql`
        UPDATE p2p.p2p_disputes
           SET resolution = 'refund',
               evidence = evidence || '[{"note":"late"}]'::jsonb
         WHERE trade_id = ${TRADE}
      `;
    } catch (err) {
      refusal = err instanceof Error ? err.message : String(err);
    }

    expect(refusal ?? 'UPDATE was allowed').toMatch(/p2p_disputes_resolved_ruling_frozen/);

    const disputes = await sql<Array<{ resolution: string | null; evidence: unknown }>>`
      SELECT resolution::text AS resolution, evidence
        FROM p2p.p2p_disputes
       WHERE trade_id = ${TRADE}
    `;
    expect(disputes).toHaveLength(1);
    expect(disputes[0]?.resolution).toBe('release');
    expect(disputes[0]?.evidence).toEqual([]);
  });
});
