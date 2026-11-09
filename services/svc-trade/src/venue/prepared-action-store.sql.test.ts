import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { parseAmount } from '@intafaced/ledger-client/money';
import type { PreparedVenueAction } from '@intafaced/venue-contracts';
import { SqlPreparedActionStore } from './prepared-action-store.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) throw new Error('TEST_DATABASE_URL is unset. The user-venue store test does not start Docker.');
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

describe('SqlPreparedActionStore on Postgres (trade.user_venue_actions)', () => {
  let db: TestDatabase | undefined;
  beforeAll(async () => {
    db = await createTestDatabase({ service: 'trade', url: adminUrl(), migrations });
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  it('keeps one action per key, exactly as prepared, and the first signature only', async () => {
    const store = new SqlPreparedActionStore(db!.sql);
    const key = `order:${USER}:sql:1`;
    const first = await store.insertOnce(USER, key, prepared('100', '60000'), new Date());
    expect(first.prepared).toEqual(prepared('100', '60000'));
    // A second prepare racing the first: the first stored action is the one.
    const second = await store.insertOnce(USER, key, prepared('101', '60000'), new Date());
    expect(second.prepared.nonce).toBe('100');
    expect(second.prepared.digest).toBe('0xdigest100');

    const signed = await store.signOnce(USER, key, { digest: '0xdigest100', signature: '0xsig-one', signedBy: OWNER }, new Date());
    expect(signed.signature?.signature).toBe('0xsig-one');
    const resigned = await store.signOnce(USER, key, { digest: '0xdigest100', signature: '0xsig-two', signedBy: OWNER }, new Date());
    expect(resigned.signature?.signature).toBe('0xsig-one');

    await store.recordOutcome(USER, key, { definite: false, reason: 'timeout' }, new Date());
    expect((await store.find(USER, key))?.lastOutcome).toEqual({ definite: false, reason: 'timeout' });
    // Another user's same key is their own row.
    expect(await store.find('22222222-2222-4222-8222-2222222222b2', key)).toBeNull();
  });

  it('the table refuses a changed action, a changed signature and a delete', async () => {
    const store = new SqlPreparedActionStore(db!.sql);
    const key = `order:${USER}:sql:2`;
    await store.insertOnce(USER, key, prepared('200', '61000'), new Date());
    await store.signOnce(USER, key, { digest: '0xdigest200', signature: '0xsig', signedBy: OWNER }, new Date());
    await expect(db!.sql`UPDATE trade.user_venue_actions SET digest = '0xother' WHERE business_key = ${key}`).rejects.toThrow(
      /only the first signature/,
    );
    await expect(
      db!.sql`UPDATE trade.user_venue_actions SET signature = '{"signature":"0xnew"}'::jsonb WHERE business_key = ${key}`,
    ).rejects.toThrow(/only the first signature/);
    await expect(db!.sql`DELETE FROM trade.user_venue_actions WHERE business_key = ${key}`).rejects.toThrow(/never deleted/);
    const [row] = await db!.sql<{ amount: string }[]>`
      SELECT prepared #>> '{intent,amount}' AS amount FROM trade.user_venue_actions WHERE business_key = ${key}`;
    expect(row?.amount).toBe('0.123456789012345678');
  });

  it('lists one person’s actions under a key prefix, oldest first, reading `_` and `%` in the prefix literally (J-wallet-22 #8)', async () => {
    const store = new SqlPreparedActionStore(db!.sql);
    const base = `session-key:${USER}:test_venue:`;
    await store.insertOnce(USER, `${base}fam.1`, prepared('300', '60000'), new Date('2026-11-09T10:00:00.000Z'));
    await store.insertOnce(USER, `${base}fam.2`, prepared('301', '60000'), new Date('2026-11-09T10:00:01.000Z'));
    // `_` would match any one character under LIKE: this key differs from the prefix only there, and is not listed.
    await store.insertOnce(USER, `session-key:${USER}:testXvenue:fam.1`, prepared('302', '60000'), new Date('2026-11-09T10:00:02.000Z'));
    await store.insertOnce('22222222-2222-4222-8222-2222222222b2', `${base}fam.1`, prepared('303', '60000'), new Date());
    const listed = await store.listByPrefix(USER, base);
    expect(listed.map((r) => r.businessKey)).toEqual([`${base}fam.1`, `${base}fam.2`]);
    expect(await store.listByPrefix(USER, `session-key:${USER}:%`)).toEqual([]);
  });

  it('finds every agent approval of one address, under any key, case-insensitively, and nothing else (J-wallet-22 #8)', async () => {
    const store = new SqlPreparedActionStore(db!.sql);
    const agent = '0x00000000000000000000000000000000000000AB';
    const approval = (nonce: string): PreparedVenueAction => ({
      ...prepared(nonce, '60000'),
      intent: { kind: 'approve_agent', agentAddress: agent, agentName: '', validUntil: new Date('2026-11-09T18:00:00.000Z') },
      venueClientOrderId: null,
      builderFee: null,
    });
    await store.insertOnce(USER, `session-key:${USER}:test-venue-sim:fam.1`, approval('400'), new Date());
    await store.insertOnce(USER, `agent-approve:${USER}:tool`, approval('401'), new Date());
    await store.insertOnce('22222222-2222-4222-8222-2222222222b2', `agent-approve:other:tool`, approval('402'), new Date());
    const found = await store.agentApprovals(USER, agent.toLowerCase());
    expect(found.map((r) => r.businessKey).sort()).toEqual([`agent-approve:${USER}:tool`, `session-key:${USER}:test-venue-sim:fam.1`]);
    expect(await store.agentApprovals(USER, '0x00000000000000000000000000000000000000cd')).toEqual([]);
  });
});
