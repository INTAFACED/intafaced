import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryLedger, parseAmount, userAvailable } from '@intafaced/ledger-client';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NetworkState } from '../../registries/policy.js';
import { CustodyDepositBook } from './book.js';

/** The customer deposit record and its crediting against a real Postgres and the memory ledger. TEST figures only. */
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_custody_deposits_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const SECRET = 'svc-pay-custody-deposit-secret-at-least-32-chars';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

const network = (over: Partial<NetworkState> = {}): NetworkState =>
  ({
    networkId: 'ethereum',
    displayName: 'Ethereum',
    assetCodes: ['USDT'],
    confirmationsRequired: 12,
    enabled: true,
    feeEstimateSource: 'fixed',
    feeEstimateAmount: '1',
    ...over,
  }) as NetworkState;

const ADDRESS = '0x00000000000000000000000000000000000000a1';
const TX = '0xAbC0000000000000000000000000000000000000000000000000000000000001';

describe('custody deposit record (real Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let networks: NetworkState[] = [];
  let ledger!: MemoryLedger;
  let failPost = false;
  const logs: Array<{ msg: string; extra?: Record<string, unknown> }> = [];

  const book = () =>
    new CustodyDepositBook({
      sql: db.sql,
      ledger: {
        balance: (ref) => ledger.balance(ref),
        post: async (req) => {
          if (failPost) throw new Error('ledger timeout');
          return ledger.post(req);
        },
      },
      registries: { listRoutableNetworks: async () => networks },
      log: (msg, extra) => logs.push({ msg, extra }),
    });
  const seen = (over: Partial<Parameters<CustodyDepositBook['receive']>[0]> = {}) => ({
    address: ADDRESS,
    txHash: TX,
    outputIndex: 0,
    assetId: 'USDT',
    amount: parseAmount('25'),
    confirmations: 12,
    ...over,
  });
  const balance = async () => (await ledger.balance(userAvailable(ALICE, 'USDT'))).amount;
  const posts = () => ledger.journal().filter((t) => t.reason === 'deposit.credited');
  async function setting(minimum = '10') {
    await db.sql`
      INSERT INTO pay.custody_deposit_settings (asset_id, network_id, label, minimum_deposit, estimated_arrival_minutes, set_by)
      VALUES ('USDT', 'ethereum', 'Ethereum', ${minimum}, 5, 'test-profile')`;
  }

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);
  beforeEach(async () => {
    networks = [network()];
    ledger = new MemoryLedger();
    failPost = false;
    logs.length = 0;
    await db.sql`TRUNCATE pay.custody_deposits, pay.custody_deposit_settings, pay.custody_deposit_addresses`;
    await db.sql`INSERT INTO pay.custody_deposit_addresses (user_id, asset_id, network_id, address) VALUES (${ALICE}, 'USDT', 'ethereum', ${ADDRESS})`;
    await setting();
  }, 30_000);

  it('answers unmatched for an address no customer holds, and writes no row', async () => {
    expect(await book().receive(seen({ address: '0x00000000000000000000000000000000000000ff' }))).toEqual({ state: 'unmatched' });
    expect(await db.sql`SELECT 1 FROM pay.custody_deposits`).toHaveLength(0);
  });

  it('credits once at the published depth, whatever the redeliveries and replicas', async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => book().receive(seen())));
    expect(results.every((r) => r.state === 'recorded' && r.status === 'credited')).toBe(true);
    await book().receive(seen());
    expect(await db.sql`SELECT status, ledger_tx_id, tx_hash FROM pay.custody_deposits`).toEqual([
      expect.objectContaining({ status: 'credited', tx_hash: TX.toLowerCase() }),
    ]);
    expect(posts()).toHaveLength(1);
    expect(await balance()).toBe(parseAmount('25'));
    expect(posts()[0]!.idempotencyKey).toBe(`deposit:crypto-native:ethereum:${TX.toLowerCase()}:0`);
  });

  it('a second output of one transaction is its own deposit', async () => {
    await book().receive(seen());
    await book().receive(seen({ outputIndex: 1 }));
    expect(posts()).toHaveLength(2);
    expect(await balance()).toBe(parseAmount('50'));
  });

  it('one confirmation short credits nothing and shows progress; the next sighting credits', async () => {
    const b = book();
    expect(await b.receive(seen({ confirmations: 11 }))).toEqual({ state: 'recorded', status: 'confirming', reason: null });
    expect(posts()).toHaveLength(0);
    const pending = await b.records({ userId: ALICE, statuses: ['detected', 'confirming'], offset: 0, limit: 50 });
    expect(pending.items).toMatchObject([{ confirmations: 11, confirmationsRequired: 12, status: 'confirming', amount: '25' }]);
    expect(await b.receive(seen({ confirmations: 12 }))).toMatchObject({ status: 'credited' });
    expect(posts()).toHaveLength(1);
  });

  it('a zero-depth sighting is detected, not confirming', async () => {
    await book().receive(seen({ confirmations: 0 }));
    expect(await db.sql`SELECT status FROM pay.custody_deposits`).toEqual([{ status: 'detected' }]);
  });

  it('under the minimum is below_minimum with its reason and never credits', async () => {
    expect(await book().receive(seen({ amount: parseAmount('9.99') }))).toEqual({
      state: 'recorded',
      status: 'below_minimum',
      reason: 'below_minimum',
    });
    await book().receive(seen({ amount: parseAmount('9.99'), confirmations: 50 }));
    expect(posts()).toHaveLength(0);
    expect((await book().records({ userId: ALICE, offset: 0, limit: 5 })).items[0]).toMatchObject({
      minimumDeposit: '10',
      reason: 'below_minimum',
    });
  });

  it('a blank minimum or a blank confirmation count credits nothing, and credits when set', async () => {
    await db.sql`TRUNCATE pay.custody_deposit_settings`;
    const b = book();
    expect(await b.receive(seen())).toEqual({ state: 'recorded', status: 'confirming', reason: 'minimum_unset' });
    await setting();
    networks = [network({ confirmationsRequired: null })];
    expect(await b.receive(seen())).toMatchObject({ reason: 'confirmations_unset' });
    expect(posts()).toHaveLength(0);
    networks = [network()];
    expect(await b.settleOpen()).toBe(1);
    expect(posts()).toHaveLength(1);
  });

  it('a ledger failure leaves the row confirming; the retry reuses the key and credits once', async () => {
    failPost = true;
    await expect(book().receive(seen())).rejects.toThrow('ledger timeout');
    expect(await db.sql`SELECT status FROM pay.custody_deposits`).toEqual([{ status: 'confirming' }]);
    failPost = false;
    expect(await book().receive(seen())).toMatchObject({ status: 'credited' });
    expect(posts()).toHaveLength(1);
  });

  it('a credit that started is finished even if the owner raises the minimum before the retry', async () => {
    failPost = true;
    await expect(book().receive(seen())).rejects.toThrow('ledger timeout');
    await db.sql`UPDATE pay.custody_deposit_settings SET minimum_deposit = '100'`;
    failPost = false;
    expect(await book().settleOpen()).toBe(1);
    expect(await db.sql`SELECT status, ledger_tx_id IS NOT NULL AS has_tx FROM pay.custody_deposits`).toEqual([
      { status: 'credited', has_tx: true },
    ]);
    expect(posts()).toHaveLength(1);
  });

  it('a crash after the post and before the flip finds the first transaction and flips once', async () => {
    const b = book();
    await b.receive(seen({ confirmations: 1 }));
    const [row] = await db.sql<Array<{ network_id: string }>>`SELECT network_id FROM pay.custody_deposits`;
    const { recipes } = await import('@intafaced/ledger-client');
    await ledger.post(
      recipes.deposit({
        userId: ALICE,
        assetId: 'USDT',
        amount: parseAmount('25'),
        rail: 'crypto-native',
        railRef: `${row!.network_id}:${TX.toLowerCase()}:0`,
      }),
    );
    await db.sql`UPDATE pay.custody_deposits SET confirmations = 12`;
    expect(await book().settleOpen()).toBe(1);
    expect(posts()).toHaveLength(1);
    expect(await balance()).toBe(parseAmount('25'));
  });

  it('a different finalized amount is needs_review and an alert, never credited', async () => {
    const b = book();
    await b.receive(seen({ confirmations: 3 }));
    expect((await b.receive(seen({ amount: parseAmount('30'), confirmations: 12 })).then((r) => r)).state).toBe('recorded');
    expect(await db.sql`SELECT status, reason FROM pay.custody_deposits`).toEqual([{ status: 'needs_review', reason: 'amount_mismatch' }]);
    expect(posts()).toHaveLength(0);
    expect(logs.some((l) => l.extra?.alert === true)).toBe(true);
  });

  it('a token the address was not issued for is rejected with an alert, not credited', async () => {
    expect(await book().receive(seen({ assetId: 'DAI' }))).toEqual({ state: 'recorded', status: 'rejected', reason: 'unknown_asset' });
    expect(posts()).toHaveLength(0);
    expect(logs.some((l) => l.extra?.alert === true)).toBe(true);
  });

  it('lists a customer own rows only, filtered and paged with a true total', async () => {
    const b = book();
    await b.receive(seen());
    await b.receive(seen({ outputIndex: 1, amount: parseAmount('1') }));
    await db.sql`INSERT INTO pay.custody_deposit_addresses (user_id, asset_id, network_id, address) VALUES (${BOB}, 'USDT', 'ethereum', '0x00000000000000000000000000000000000000b2')`;
    await b.receive(seen({ address: '0x00000000000000000000000000000000000000b2', txHash: TX.replace('1', '2') }));
    const all = await b.records({ userId: ALICE, offset: 0, limit: 1 });
    expect(all.total).toBe(2);
    expect(all.items).toHaveLength(1);
    expect((await b.records({ userId: ALICE, statuses: ['below_minimum'], offset: 0, limit: 50 })).items).toHaveLength(1);
    expect(
      (await b.records({ userId: ALICE, txHash: TX, address: ADDRESS.toUpperCase().replace('0X', '0x'), offset: 0, limit: 50 })).total,
    ).toBe(2);
    expect((await b.records({ userId: BOB, offset: 0, limit: 50 })).total).toBe(1);
  });

  it('the invariant: every credited row has exactly one deposit post', async () => {
    const b = book();
    for (let i = 0; i < 5; i++) await b.receive(seen({ outputIndex: i }));
    await b.receive(seen({ outputIndex: 9, amount: parseAmount('2') }));
    const credited = await db.sql<
      Array<{ output_index: number; ledger_tx_id: string }>
    >`SELECT output_index, ledger_tx_id FROM pay.custody_deposits WHERE status = 'credited'`;
    expect(credited).toHaveLength(5);
    expect(posts()).toHaveLength(5);
    expect(new Set(credited.map((r) => r.ledger_tx_id)).size).toBe(5);
    await expect(db.sql`UPDATE pay.custody_deposits SET status = 'credited' WHERE output_index = 9`).rejects.toThrow();
  });
});
