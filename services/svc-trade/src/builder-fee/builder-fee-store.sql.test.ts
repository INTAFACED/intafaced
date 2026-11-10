import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { parseAmount } from '@intafaced/ledger-client/money';
import type { PreparedVenueAction } from '@intafaced/venue-contracts';
import { SqlPreparedActionStore } from '../venue/prepared-action-store.js';
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
  const fee = (fillId: string, at: string, status: 'posted' | 'refused' | 'not_our_order', acct = account) => ({
    venueId: 'test-venue-sim',
    fillId,
    userId: USER,
    account: acct,
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
    // The same wallet under a second user is still one venue account, under the user who sent its first order.
    const later = new Date('2026-11-09T10:01:00.000Z');
    const OTHER = '22222222-2222-4222-8222-2222222222b2';
    await actions.insertOnce(OTHER, `order:${OTHER}:sql:1`, prepared('102', '60000'), later);
    await actions.signOnce(OTHER, `order:${OTHER}:sql:1`, { digest: '0xdigest102', signature: '0xsig', signedBy: OWNER }, later);
    expect(await store.accounts('test-venue-sim')).toEqual([{ userId: USER, account, since: created }]);
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

  it('keeps one row per venue, account and fill: the two sides of one trade are two rows (OWNER 288 1a)', async () => {
    const store = new SqlBuilderFeeStore(db!.sql);
    const other = { venueId: 'test-venue-sim', owner: '0x00000000000000000000000000000000000000b2', subAccount: null };
    const sub = { venueId: 'test-venue-sim', owner: OWNER, subAccount: '0x00000000000000000000000000000000000000c3' };
    const at = '2026-11-09T13:00:00.000Z';
    await store.record(fee('t1', at, 'posted'), new Date());
    await store.record(fee('t1', at, 'posted', other), new Date());
    await store.record(fee('t1', at, 'posted', sub), new Date());
    const rows = await store.inPeriod('test-venue-sim', new Date(at), new Date('2026-11-09T14:00:00.000Z'));
    expect(rows.map((r) => [r.account.owner, r.account.subAccount])).toEqual([
      [OWNER, null],
      [OWNER, sub.subAccount],
      [other.owner, null],
    ]);
    const keys = await db!.sql<{ venue_account: string }[]>`
      SELECT venue_account FROM trade.venue_builder_fees WHERE fill_id = 't1' ORDER BY venue_account`;
    expect(keys.map((k) => k.venue_account)).toEqual([OWNER, `${OWNER}/${sub.subAccount}`, other.owner]);
  });

  it('records "not our order" with no ledger transaction, replaced by a later outcome, never over a posted one (1b)', async () => {
    const store = new SqlBuilderFeeStore(db!.sql);
    const at = '2026-11-09T15:00:00.000Z';
    const period = [new Date(at), new Date('2026-11-09T16:00:00.000Z')] as const;
    await store.record(fee('n1', at, 'not_our_order'), new Date());
    expect(await store.inPeriod('test-venue-sim', ...period)).toEqual([fee('n1', at, 'not_our_order')]);
    await store.record(fee('n1', at, 'posted'), new Date());
    await store.record(fee('n1', at, 'not_our_order'), new Date());
    expect(await store.inPeriod('test-venue-sim', ...period)).toEqual([fee('n1', at, 'posted')]);
    await expect(
      db!.sql`UPDATE trade.venue_builder_fees SET status = 'not_our_order', refusal_code = NULL WHERE fill_id = 'n1'`,
    ).rejects.toThrow(/venue_builder_fees_outcome_ck/);
  });

  it('keeps the poster runs per venue: the last complete run and the last stop (1c)', async () => {
    const store = new SqlBuilderFeeStore(db!.sql);
    expect(await store.runState('test-venue-sim')).toEqual({ lastCompleteAt: null, lastStopAt: null, lastStop: null });
    const done = new Date('2026-11-10T01:00:00.000Z');
    await store.markComplete('test-venue-sim', done);
    const stop = {
      venueId: 'test-venue-sim',
      venueAccount: OWNER,
      fillId: 't6',
      code: 'ledger.idempotency_conflict',
      message: 'key booked with another body',
    };
    const stoppedAt = new Date('2026-11-10T01:00:10.000Z');
    await store.markStopped(stop, stoppedAt);
    expect(await store.runState('test-venue-sim')).toEqual({ lastCompleteAt: done, lastStopAt: stoppedAt, lastStop: stop });
    expect((await store.runState('another-venue')).lastCompleteAt).toBeNull();
  });
});

describe('SqlPreparedActionStore.sentBuilderFeeOrders on Postgres (OWNER 288 1b)', () => {
  let db: TestDatabase | undefined;
  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url: adminUrl(), migrations });
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  it('names only orders this door stored for that account with our builder fee and signed', async () => {
    const actions = new SqlPreparedActionStore(db!.sql);
    const account = { owner: OWNER, subAccount: null };
    const at = new Date('2026-11-10T00:00:00.000Z');
    await actions.insertOnce(USER, `order:${USER}:sent:1`, prepared('200', '60000'), at);
    // Stored but never signed: never sent, so not ours.
    expect([...(await actions.sentBuilderFeeOrders('test-venue-sim', account, ['0x0123']))]).toEqual([]);
    await actions.signOnce(USER, `order:${USER}:sent:1`, { digest: '0xdigest200', signature: '0xsig', signedBy: OWNER }, at);
    expect([...(await actions.sentBuilderFeeOrders('test-venue-sim', account, ['0x0123', 'elsewhere']))]).toEqual(['0x0123']);
    // Another account, another venue, or a sub-account: not ours on that account.
    expect([...(await actions.sentBuilderFeeOrders('test-venue-sim', { owner: '0xb2', subAccount: null }, ['0x0123']))]).toEqual([]);
    expect([...(await actions.sentBuilderFeeOrders('another-venue', account, ['0x0123']))]).toEqual([]);
    expect([...(await actions.sentBuilderFeeOrders('test-venue-sim', { owner: OWNER, subAccount: '0xc3' }, ['0x0123']))]).toEqual([]);
    expect([...(await actions.sentBuilderFeeOrders('test-venue-sim', account, []))]).toEqual([]);
  });
});
