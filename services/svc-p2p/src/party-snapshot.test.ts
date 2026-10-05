import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * `seller_id` and `buyer_id` are the parties `settleOnce` passes to
 * `escrowRelease` and `escrowRefund`. 0000 calls them a snapshot so a later
 * edit cannot re-point an open escrow, but the only party constraint there is
 * `seller_id <> buyer_id`. This suite is raw SQL: a service method that never
 * writes the columns does not freeze them.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SELLER = '11111111-1111-4111-8111-111111111111';
const BUYER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const OFFER = '00000000-0000-4000-8000-0000000000f0';
const TRADE = '00000000-0000-4000-8000-0000000000a5';

const H8A_IMAGE = 'postgres:16-alpine';

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
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
      `L5: party snapshot is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('p2p trade party snapshot', () => {
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
        ${OFFER}, ${SELLER}, 'sell', 'USDT', 'USD', 'fixed', 1,
        10, 500, 500, 400, '["sepa"]'::jsonb
      )
    `;
    await sql`
      INSERT INTO p2p.p2p_trades (
        id, offer_id, taker_id, maker_id, seller_id, buyer_id, asset, fiat_currency,
        amount, price, fiat_amount, method, status, deadline_at, escrowed_at
      ) VALUES (
        ${TRADE}, ${OFFER}, ${BUYER}, ${SELLER}, ${SELLER}, ${BUYER}, 'USDT', 'USD',
        100, 1, 100, 'sepa', 'escrowed', now() + interval '1 hour', now()
      )
    `;
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  it('refuses to re-point seller_id or buyer_id on an open trade', async () => {
    await expect(sql`UPDATE p2p.p2p_trades SET seller_id = ${OTHER} WHERE id = ${TRADE}`).rejects.toThrow(
      /snapshotted at take/,
    );
    await expect(sql`UPDATE p2p.p2p_trades SET buyer_id = ${OTHER} WHERE id = ${TRADE}`).rejects.toThrow(
      /snapshotted at take/,
    );

    const parties = await sql<Array<{ seller_id: string; buyer_id: string }>>`
      SELECT seller_id, buyer_id FROM p2p.p2p_trades WHERE id = ${TRADE}
    `;
    expect(parties[0]).toEqual({ seller_id: SELLER, buyer_id: BUYER });

    await sql`UPDATE p2p.p2p_trades SET deadline_at = now() + interval '2 hours' WHERE id = ${TRADE}`;
    const after = await sql<Array<{ seller_id: string; buyer_id: string }>>`
      SELECT seller_id, buyer_id FROM p2p.p2p_trades WHERE id = ${TRADE}
    `;
    expect(after[0]).toEqual({ seller_id: SELLER, buyer_id: BUYER });
  });
});
