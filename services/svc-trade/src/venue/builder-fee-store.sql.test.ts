import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { parseAmount } from '@intafaced/ledger-client/money';
import type { PreparedVenueAction } from '@intafaced/venue-contracts';
import { SqlPreparedActionStore } from './prepared-action-store.js';
import { BUILDER_FEE_READ_OVERLAP_MS, SqlBuilderFeeStore } from './builder-fee-store.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is unset. The builder-fee store test does not start Docker.');
  const url = new URL(raw);
  if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const USER = '11111111-1111-4111-8111-1111111111b1';
const OWNER = '0x00000000000000000000000000000000000000a1';

const prepared = (nonce: string, price: string): PreparedVenueAction => ({
  venueId: 'test-venue-sim',
  account: { venueId: 'test-venue-sim', owner: OWNER, subAccount: null },
  signer: { role: 'owner', address: OWNER },
  intent: {
    kind: 'place_order',
    symbol: 'BTC-USDC',
    side: 'buy',
    type: 'limit',
    amount: parseAmount('0.123456789012345678'),
    price: parseAmount(price),
    timeInForce: 'GTC',
    reduceOnly: false,
    clientOrderKey: `order:${USER}:sql:1`,
    builderFee: { builder: OWNER, feeBps: parseAmount('0.5') },
  },
  nonce,
  venueClientOrderId: '0x0123',
  typedData: { domain: { chainId: 84532 }, message: { payload: '{"amount":"0.123456789012345678"}' } },
  digest: `0xdigest${nonce}`,
  builderFee: { builder: OWNER, feeBps: parseAmount('0.5') },
  preparedAt: new Date('2026-11-08T19:00:00.000Z'),
});

describe('SqlBuilderFeeStore on Postgres (trade.venue_builder_fees)', () => {
  let db: TestDatabase | undefined;
  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url: adminUrl(), migrations });
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  const account = { venueId: 'test-venue-sim', owner: OWNER, subAccount: null };
  const fee = (fillId: string, at: string, status: 'posted' | 'refused') => ({
    venueId: 'test-venue-sim',
    fillId,
    userId: USER,
    account,
    assetId: 'USDC',
    amount: parseAmount('0.000123456789012345'),
    filledAt: new Date(at),
    status,
    refusalCode: status === 'refused' ? 'ledger.asset_unknown' : null,
    ledgerTxId: status === 'posted' ? `tx-${fillId}` : null,
  });

  it('lists the accounts that sent an order with our builder fee, reading on from a minute before their latest recorded fill', async () => {
    const sql = db!.sql;
    const store = new SqlBuilderFeeStore(sql);
    const actions = new SqlPreparedActionStore(sql);
    const created = new Date('2026-11-09T10:00:00.000Z');
    await actions.insertOnce(USER, `order:${USER}:sql:1`, prepared('100', '60000'), created);
    // Signed only: an order never signed was never sent, so its account is not listed.
    expect(await store.accounts('test-venue-sim')).toEqual([]);
    await actions.signOnce(USER, `order:${USER}:sql:1`, { digest: '0xdigest100', signature: '0xsig', signedBy: OWNER }, created);
    expect(await store.accounts('test-venue-sim')).toEqual([{ userId: USER, account, since: created }]);
    expect(await store.accounts('another-venue')).toEqual([]);
    await store.record(fee('f1', '2026-11-09T10:05:00.000Z', 'posted'), new Date());
    expect((await store.accounts('test-venue-sim'))[0]?.since).toEqual(
      new Date(Date.parse('2026-11-09T10:05:00.000Z') - BUILDER_FEE_READ_OVERLAP_MS),
    );
  });

  it('keeps a posted fill posted, replaces a refused one, and lists a period exactly, amounts to the last digit', async () => {
    const store = new SqlBuilderFeeStore(db!.sql);
    await store.record(fee('f2', '2026-11-09T11:00:00.000Z', 'refused'), new Date());
    await store.record(fee('f2', '2026-11-09T11:00:00.000Z', 'posted'), new Date());
    await store.record(fee('f2', '2026-11-09T11:00:00.000Z', 'refused'), new Date());
    const rows = await store.inPeriod('test-venue-sim', new Date('2026-11-09T11:00:00.000Z'), new Date('2026-11-09T12:00:00.000Z'));
    expect(rows).toEqual([fee('f2', '2026-11-09T11:00:00.000Z', 'posted')]);
    // The period's end is open: a fill at exactly `to` belongs to the next period.
    expect(await store.inPeriod('test-venue-sim', new Date('2026-11-09T10:00:00.000Z'), new Date('2026-11-09T11:00:00.000Z'))).toEqual([
      fee('f1', '2026-11-09T10:05:00.000Z', 'posted'),
    ]);
    // The table refuses a posted row with no ledger transaction.
    await expect(db!.sql`UPDATE trade.venue_builder_fees SET ledger_tx_id = NULL WHERE fill_id = 'f2'`).rejects.toThrow(
      /venue_builder_fees_outcome_ck/,
    );
  });
});
