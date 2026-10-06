import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';

/**
 * ONCE ESCROWED, THE TRADE AMOUNT IS THE FIGURE THE LEDGER ALREADY MOVED.
 *
 * `escrowLock` posts the amount on the row. `settleOnce` posts whatever amount
 * is on the row later. `p2p_trades_amounts_positive_ck` only requires amount > 0,
 * so a later UPDATE can lower it. Settlement then releases the new figure and
 * the difference stays in that trade's escrow. The trade is terminal, so
 * nothing refunds the remainder.
 *
 * The service never writes amount after insert. A psql session, a migration,
 * or the next writer does not go through the service. This suite is raw SQL
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
const TRADE = '00000000-0000-4000-8000-000000000302';

/** The figure escrowLock moved. Not derived. */
const ORIGINAL_AMOUNT = '250.500000000000000000';
/** A smaller positive figure. Still legal under the > 0 check. */
const LOWERED_AMOUNT = '10.000000000000000000';
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
      `svc-p2p escrow amount freeze is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('p2p escrow amount is frozen once escrowed', () => {
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

  it('refuses an amount change once escrowed_at is set and leaves the original amount', async () => {
    let refusal: string | null = null;
    try {
      await sql`
        UPDATE p2p.p2p_trades
           SET amount = ${LOWERED_AMOUNT}::numeric
         WHERE id = ${TRADE}
      `;
    } catch (err) {
      refusal = err instanceof Error ? err.message : String(err);
    }

    expect(refusal ?? 'UPDATE was allowed').toMatch(/frozen once escrowed/);

    const rows = await sql<Array<{ amount: string }>>`
      SELECT amount::text AS amount FROM p2p.p2p_trades WHERE id = ${TRADE}
    `;
    expect(rows[0]?.amount).toBe(ORIGINAL_AMOUNT);
  });
});
