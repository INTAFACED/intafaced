import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * trade_payment_instruments is documented as the pay-to account frozen when the trade opens, so a seller cannot swap destinations mid-trade. trade_payment_instruments_purge_paired_ck only pairs details IS NULL with purged_at. While the row is unpurged, UPDATE details and fingerprint to a different account succeeds. No trigger restricts updates to the purge transition, so revealForTrade can show a new account after the buyer has started the transfer to the original one.
 *
 * Raw SQL. `revealForTrade` reads this row; a service method that never updates it does not freeze it.
 * The parent offer and trade exist so the snapshot's foreign keys are satisfied. Their numeric literals are the same positive fixtures the other p2p SQL suites already insert, written as decimal strings.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SELLER = '11111111-1111-4111-8111-111111111111';
const BUYER = '22222222-2222-4222-8222-222222222222';
const OFFER = '00000000-0000-4000-8000-0000000000f0';
const TRADE = '00000000-0000-4000-8000-0000000000a6';
const INSTRUMENT = '00000000-0000-4000-8000-0000000000b1';
const ORIGINAL_FINGERPRINT = 'a'.repeat(64);
const SWAPPED_FINGERPRINT = 'b'.repeat(64);
const ORIGINAL_ACCOUNT = 'original-pay-to';
const SWAPPED_ACCOUNT = 'swapped-pay-to';

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
      `L6: pay-to snapshot is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('p2p pay-to snapshot', () => {
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
    await sql`TRUNCATE p2p.trade_payment_instruments, p2p.payment_instruments, p2p.p2p_trades, p2p.offers RESTART IDENTITY CASCADE`;
    await sql`
      INSERT INTO p2p.offers (
        id, maker_id, side, asset, fiat_currency, price_type, price,
        min_amt, max_amt, total_amt, remaining_amt, methods
      ) VALUES (
        ${OFFER}, ${SELLER}, 'sell', 'USDT', 'USD', 'fixed', '1'::numeric,
        '10'::numeric, '500'::numeric, '500'::numeric, '400'::numeric, '["sepa"]'::jsonb
      )
    `;
    await sql`
      INSERT INTO p2p.p2p_trades (
        id, offer_id, taker_id, maker_id, seller_id, buyer_id, asset, fiat_currency,
        amount, price, fiat_amount, method, status, deadline_at, escrowed_at
      ) VALUES (
        ${TRADE}, ${OFFER}, ${BUYER}, ${SELLER}, ${SELLER}, ${BUYER}, 'USDT', 'USD',
        '100'::numeric, '1'::numeric, '100'::numeric, 'sepa', 'escrowed', now() + interval '1 hour', now()
      )
    `;
    await sql`
      INSERT INTO p2p.payment_instruments (
        id, owner_id, method_id, country, fiat_currency, label, details, fingerprint, status
      ) VALUES (
        ${INSTRUMENT}, ${SELLER}, 'sepa', 'DE', 'USD', 'Main',
        ${sql.json({ account_reference: ORIGINAL_ACCOUNT })}, ${ORIGINAL_FINGERPRINT}, 'active'
      )
    `;
    await sql`
      INSERT INTO p2p.trade_payment_instruments (
        trade_id, instrument_id, owner_id, method_id, country, fiat_currency, label, details, fingerprint
      ) VALUES (
        ${TRADE}, ${INSTRUMENT}, ${SELLER}, 'sepa', 'DE', 'USD', 'Main',
        ${sql.json({ account_reference: ORIGINAL_ACCOUNT })}, ${ORIGINAL_FINGERPRINT}
      )
    `;
  });

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  it('refuses a destination swap on an unpurged pay-to row, still purges, and a later read shows the original account', async () => {
    const swapped = sql.json({ account_reference: SWAPPED_ACCOUNT });

    await expect(
      sql`
        UPDATE p2p.trade_payment_instruments
           SET details = ${swapped}, fingerprint = ${SWAPPED_FINGERPRINT}
         WHERE trade_id = ${TRADE}
      `,
    ).rejects.toThrow(/pay-to account frozen/);

    await expect(
      sql`
        UPDATE p2p.trade_payment_instruments
           SET details = ${swapped}
         WHERE trade_id = ${TRADE}
      `,
    ).rejects.toThrow(/pay-to account frozen/);

    await expect(
      sql`
        UPDATE p2p.trade_payment_instruments
           SET fingerprint = ${SWAPPED_FINGERPRINT}
         WHERE trade_id = ${TRADE}
      `,
    ).rejects.toThrow(/pay-to account frozen/);

    await expect(
      sql`
        UPDATE p2p.trade_payment_instruments
           SET details = NULL, purged_at = now(), fingerprint = ${SWAPPED_FINGERPRINT}
         WHERE trade_id = ${TRADE}
      `,
    ).rejects.toThrow(/pay-to account frozen/);

    const still = await sql<Array<{ details: { account_reference: string }; fingerprint: string; purged_at: Date | null }>>`
      SELECT details, fingerprint, purged_at
        FROM p2p.trade_payment_instruments
       WHERE trade_id = ${TRADE}
    `;
    expect(still[0]?.details).toEqual({ account_reference: ORIGINAL_ACCOUNT });
    expect(still[0]?.fingerprint).toBe(ORIGINAL_FINGERPRINT);
    expect(still[0]?.purged_at).toBeNull();

    await sql`
      UPDATE p2p.trade_payment_instruments
         SET details = NULL, purged_at = now()
       WHERE trade_id = ${TRADE}
    `;

    const purged = await sql<Array<{ details: unknown; fingerprint: string; purged_at: Date | null }>>`
      SELECT details, fingerprint, purged_at
        FROM p2p.trade_payment_instruments
       WHERE trade_id = ${TRADE}
    `;
    expect(purged[0]?.details).toBeNull();
    expect(purged[0]?.fingerprint).toBe(ORIGINAL_FINGERPRINT);
    expect(purged[0]?.purged_at).toBeInstanceOf(Date);
  });
});
