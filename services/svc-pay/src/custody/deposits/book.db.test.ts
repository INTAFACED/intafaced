import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryLedger, parseAmount, recipes, userAvailable } from '@intafaced/ledger-client';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NetworkState } from '../../registries/policy.js';
import { UserMoneyService } from '../../user-money-service.js';
import { RailRegistry } from '../../rails/registry.js';
import { CryptoNativeAdapter } from '../../rails/crypto-native.js';
import { MemoryChain } from '../../rails/chain-port.js';
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
      postDeposit: async (input) => {
        if (failPost) throw new Error('ledger timeout');
        const { networkId, txHash, outputIndex, ...rest } = input;
        return ledger.post(recipes.deposit({ ...rest, rail: 'crypto-native', railRef: `${networkId}:${txHash}:${outputIndex}` }));
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
    await db.sql`TRUNCATE pay.custody_deposits, pay.custody_deposit_settings, pay.custody_deposit_addresses, pay.custody_deposit_reorgs`;
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

  describe('an extra address after its expiry (W-deposit-02)', () => {
    const EXTRA = '0x00000000000000000000000000000000000000b2';
    async function extra(expiresIn: string) {
      await db.sql`
        INSERT INTO pay.custody_deposit_addresses (user_id, asset_id, network_id, address_index, address, expires_at)
        VALUES (${ALICE}, 'USDT', 'ethereum', 1, ${EXTRA}, now() + ${expiresIn}::interval)`;
    }

    it('a new transfer is held for release with an alert, recorded for the owner and never credited', async () => {
      await extra('-1 hour');
      const b = book();
      expect(await b.receive(seen({ address: EXTRA }))).toEqual({
        state: 'recorded',
        status: 'held_for_release',
        reason: 'address_expired',
      });
      // Redeliveries and the open-row pass leave it held: only a person releases it.
      await b.receive(seen({ address: EXTRA }));
      await book().receive(seen({ address: EXTRA }));
      expect(await book().settleOpen()).toBe(0);
      expect(await db.sql`SELECT user_id, status, reason, amount, credited_at FROM pay.custody_deposits`).toEqual([
        { user_id: ALICE, status: 'held_for_release', reason: 'address_expired', amount: '25', credited_at: null },
      ]);
      expect(posts()).toHaveLength(0);
      expect(await balance()).toBe(0n);
      expect(logs.some((l) => l.msg === 'custody deposit held for release: the address had expired' && l.extra?.alert === true)).toBe(true);
      expect((await book().records({ userId: ALICE, offset: 0, limit: 10 })).items).toEqual([
        expect.objectContaining({ status: 'held_for_release', reason: 'address_expired', amount: '25' }),
      ]);
    });

    it('a transfer to an extra address before its expiry credits as any other', async () => {
      await extra('30 days');
      expect(await book().receive(seen({ address: EXTRA }))).toMatchObject({ state: 'recorded', status: 'credited' });
      expect(posts()).toHaveLength(1);
    });

    it('a transfer first seen before the expiry still credits when it confirms after it', async () => {
      await extra('30 days');
      await book().receive(seen({ address: EXTRA, confirmations: 3 }));
      await db.sql`UPDATE pay.custody_deposit_addresses SET expires_at = now() - interval '1 hour' WHERE address_index = 1`;
      expect(await book().receive(seen({ address: EXTRA, confirmations: 12 }))).toMatchObject({ state: 'recorded', status: 'credited' });
      expect(posts()).toHaveLength(1);
      expect(await balance()).toBe(parseAmount('25'));
    });

    it('a token the expired address was not issued for is still rejected, not held', async () => {
      await extra('-1 hour');
      expect(await book().receive(seen({ address: EXTRA, assetId: 'DAI' }))).toEqual({
        state: 'recorded',
        status: 'rejected',
        reason: 'unknown_asset',
      });
    });
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

  describe('a transfer the chain takes back (W-deposit-06)', () => {
    // The real engines: the credit and its reversal post through UserMoneyService, so the keys are the ones production uses.
    let failReverse = false;
    const engines = () =>
      new UserMoneyService(
        db.sql,
        ledger,
        new RailRegistry([
          new CryptoNativeAdapter({ chain: new MemoryChain(), secret: SECRET, minConfirmations: 6, toleranceSeconds: 300 }),
        ]),
        { operatorCreditRails: [] },
      );
    const reorging = (wired = true) => {
      const money = engines();
      return new CustodyDepositBook({
        sql: db.sql,
        postDeposit: (input) => money.postCustodyDeposit(input),
        ...(wired
          ? {
              reverseDeposit: async (input: Parameters<UserMoneyService['reverseCustodyDeposit']>[0]) => {
                if (failReverse) throw new Error('ledger timeout');
                return money.reverseCustodyDeposit(input);
              },
            }
          : {}),
        registries: { listRoutableNetworks: async () => networks },
        log: (msg, extra) => logs.push({ msg, extra }),
      });
    };
    const reorg = (over: Partial<{ address: string; txHash: string; outputIndex: number }> = {}) => ({
      address: ADDRESS,
      txHash: TX,
      outputIndex: 0,
      ...over,
    });
    const reversals = () => ledger.journal().filter((t) => t.reason === 'deposit.reversed');
    const row = async () =>
      (
        await db.sql<Array<{ status: string; reason: string | null; ledger_tx_id: string | null; reversal_ledger_tx_id: string | null }>>`
          SELECT status, reason, ledger_tx_id, reversal_ledger_tx_id FROM pay.custody_deposits`
      )[0]!;
    /** Takes `amount` out of Alice's available TEST balance into a withdrawal hold, as a withdrawal would. */
    async function spend(amount: string) {
      await ledger.post(
        recipes.withdrawHold({
          userId: ALICE,
          assetId: 'USDT',
          amount: parseAmount(amount),
          rail: 'crypto-native',
          withdrawalId: `test-spend-${amount}`,
        }),
      );
    }
    beforeEach(() => {
      failReverse = false;
    });

    it('a credited deposit is reversed once: one depositReverse under its business key, the balance drops by the amount once', async () => {
      const b = reorging();
      await b.receive(seen());
      expect(await balance()).toBe(parseAmount('25'));
      const outcomes = await Promise.all(Array.from({ length: 3 }, () => b.reverse(reorg())));
      expect(outcomes.every((o) => o.state === 'recorded' && o.status === 'reversed' && o.reason === 'chain_reorg')).toBe(true);
      await reorging().reverse(reorg({ txHash: TX.toLowerCase() }));
      expect(reversals()).toHaveLength(1);
      expect(reversals()[0]!.idempotencyKey).toBe(`deposit.reverse:crypto-native:ethereum:${TX.toLowerCase()}:0`);
      expect(await balance()).toBe(0n);
      const after = await row();
      expect(after).toMatchObject({ status: 'reversed', reason: 'chain_reorg' });
      expect(after.ledger_tx_id).toBe(posts()[0]!.id);
      expect(after.reversal_ledger_tx_id).toBe(reversals()[0]!.id);
    });

    it('a deposit not yet credited is closed reversed and posts nothing', async () => {
      const b = reorging();
      await b.receive(seen({ confirmations: 2 }));
      expect(await b.reverse(reorg())).toEqual({ state: 'recorded', status: 'reversed', reason: 'chain_reorg' });
      expect(posts()).toHaveLength(0);
      expect(reversals()).toHaveLength(0);
      // Later sightings of the reversed transfer at full depth do not credit it.
      expect(await b.settleOpen()).toBe(0);
    });

    it('a reversed transfer seen again is never credited on its own: review, with an alert', async () => {
      const b = reorging();
      await b.receive(seen({ confirmations: 2 }));
      await b.reverse(reorg());
      logs.length = 0;
      expect(await b.receive(seen())).toMatchObject({ status: 'needs_review', reason: 'chain_reorg' });
      expect(await b.receive(seen())).toMatchObject({ status: 'needs_review', reason: 'chain_reorg' });
      expect(await b.settleOpen()).toBe(0);
      expect(posts()).toHaveLength(0);
      expect(logs.filter((l) => l.extra?.alert === true)).toHaveLength(1);
      // Reported again, it closes again, still with nothing posted.
      expect(await b.reverse(reorg())).toMatchObject({ status: 'reversed' });
      expect(posts()).toHaveLength(0);
    });

    it('a reorg that arrives before its sighting is kept: the late sighting goes to review, never credited', async () => {
      const b = reorging();
      expect(await b.reverse(reorg())).toEqual({ state: 'unknown' });
      logs.length = 0;
      expect(await b.receive(seen())).toMatchObject({ status: 'needs_review', reason: 'chain_reorg' });
      expect(posts()).toHaveLength(0);
      expect(logs.some((l) => l.extra?.alert === true)).toBe(true);
      // Another position at the same address is not touched by it.
      expect(await b.receive(seen({ outputIndex: 1 }))).toMatchObject({ status: 'credited' });
    });

    it('a settled outcome another instance remembered is checked against the row, so a reorg elsewhere is not hidden', async () => {
      const a = reorging();
      const other = reorging();
      await a.receive(seen({ amount: parseAmount('2') }));
      expect(await other.receive(seen({ amount: parseAmount('2') }))).toMatchObject({ status: 'below_minimum' });
      await a.reverse(reorg());
      expect(await other.receive(seen({ amount: parseAmount('2') }))).toMatchObject({ status: 'needs_review', reason: 'chain_reorg' });
    });

    it('a token the address was not issued for keeps its rejection through a reorg; the credited row is the one answered', async () => {
      const b = reorging();
      await b.receive(seen({ assetId: 'DAI' }));
      await b.receive(seen());
      expect(await b.reverse(reorg())).toEqual({ state: 'recorded', status: 'reversed', reason: 'chain_reorg' });
      expect(await db.sql`SELECT asset_id, status, reason FROM pay.custody_deposits ORDER BY asset_id`).toEqual([
        { asset_id: 'DAI', status: 'rejected', reason: 'unknown_asset' },
        { asset_id: 'USDT', status: 'reversed', reason: 'chain_reorg' },
      ]);
      expect(reversals()).toHaveLength(1);
    });

    it('a reversed credit seen again stays reversed with an alert: its credit key is spent', async () => {
      const b = reorging();
      await b.receive(seen());
      await b.reverse(reorg());
      logs.length = 0;
      expect(await reorging().receive(seen())).toMatchObject({ status: 'reversed' });
      expect(posts()).toHaveLength(1);
      expect(reversals()).toHaveLength(1);
      expect(logs.some((l) => l.extra?.alert === true)).toBe(true);
      expect(await balance()).toBe(0n);
    });

    it('funds already spent: needs_review with an alert, nothing posted, never a negative balance; covered later, it reverses once', async () => {
      const b = reorging();
      await b.receive(seen());
      await spend('20');
      logs.length = 0;
      expect(await b.reverse(reorg())).toEqual({ state: 'recorded', status: 'needs_review', reason: 'reversal_unfunded' });
      expect(reversals()).toHaveLength(0);
      expect(await balance()).toBe(parseAmount('5'));
      expect(logs.some((l) => l.extra?.alert === true && l.extra.depositId)).toBe(true);
      expect(await db.sql`SELECT reversal_started_at FROM pay.custody_deposits`).toEqual([{ reversal_started_at: null }]);
      // Topped up (TEST), a later reorg delivery reverses it, once.
      await ledger.post(recipes.deposit({ userId: ALICE, assetId: 'USDT', amount: parseAmount('20'), rail: 'test', railRef: 'top-up' }));
      expect(await b.reverse(reorg())).toMatchObject({ status: 'reversed', reason: 'chain_reorg' });
      expect(reversals()).toHaveLength(1);
      expect(await balance()).toBe(0n);
    });

    it('a ledger failure leaves the reversal started and the row no longer credited; the next pass finishes it, once', async () => {
      const b = reorging();
      await b.receive(seen());
      failReverse = true;
      await expect(b.reverse(reorg())).rejects.toThrow('ledger timeout');
      // Not `credited` any more: a sweep or an announcement does not treat it as money that stays.
      expect(await db.sql`SELECT status, reason, reversal_started_at IS NOT NULL AS started FROM pay.custody_deposits`).toEqual([
        { status: 'needs_review', reason: 'chain_reorg', started: true },
      ]);
      expect(await b.receive(seen())).toMatchObject({ status: 'needs_review' });
      failReverse = false;
      // No reorg redelivery needed: the watcher tick's settle pass finishes it under the same key.
      await reorging().settleOpen();
      expect(await row()).toMatchObject({ status: 'reversed', reason: 'chain_reorg' });
      await reorging().reverse(reorg());
      expect(reversals()).toHaveLength(1);
      expect(await balance()).toBe(0n);
    });

    it('a crash after the reversal posted and before the flip finds the first reversal and flips once', async () => {
      const b = reorging();
      await b.receive(seen());
      await engines().reverseCustodyDeposit({
        userId: ALICE,
        assetId: 'USDT',
        amount: parseAmount('25'),
        networkId: 'ethereum',
        txHash: TX.toLowerCase(),
        outputIndex: 0,
      });
      await db.sql`UPDATE pay.custody_deposits SET reversal_started_at = now(), status = 'needs_review', reason = 'chain_reorg'`;
      expect(await reorging().reverse(reorg())).toMatchObject({ status: 'reversed' });
      expect(reversals()).toHaveLength(1);
      expect(await balance()).toBe(0n);
    });

    it('a credit a crash cut short is finished first, then reversed: one credit, one reversal', async () => {
      const b = reorging();
      failPost = true;
      await expect(
        new CustodyDepositBook({
          sql: db.sql,
          postDeposit: async () => {
            throw new Error('ledger timeout');
          },
          registries: { listRoutableNetworks: async () => networks },
        }).receive(seen()),
      ).rejects.toThrow('ledger timeout');
      failPost = false;
      expect(await db.sql`SELECT status, credit_started_at IS NOT NULL AS started FROM pay.custody_deposits`).toEqual([
        { status: 'confirming', started: true },
      ]);
      expect(await b.reverse(reorg())).toMatchObject({ status: 'reversed', reason: 'chain_reorg' });
      expect(posts()).toHaveLength(1);
      expect(reversals()).toHaveLength(1);
      expect(await balance()).toBe(0n);
    });

    it('unwired, a credited row refuses and stays credited; a never-credited one still closes', async () => {
      await reorging().receive(seen());
      await expect(reorging(false).reverse(reorg())).rejects.toThrow('pay.deposit_reverse_unwired');
      expect(await row()).toMatchObject({ status: 'credited' });
      await reorging().receive(seen({ outputIndex: 1, confirmations: 1 }));
      expect(await reorging(false).reverse(reorg({ outputIndex: 1 }))).toMatchObject({ status: 'reversed' });
    });

    it('an address no customer holds is unmatched; a customer address with no such transfer is unknown; nothing is written', async () => {
      expect(await reorging().reverse(reorg({ address: '0x00000000000000000000000000000000000000ff' }))).toEqual({ state: 'unmatched' });
      expect(await reorging().reverse(reorg())).toEqual({ state: 'unknown' });
      expect(await db.sql`SELECT 1 FROM pay.custody_deposits`).toHaveLength(0);
    });

    it('the invariant: every reversed credit has exactly one reversal post, and the table refuses a reversal with no credit', async () => {
      const b = reorging();
      for (let i = 0; i < 4; i++) await b.receive(seen({ outputIndex: i }));
      for (let i = 0; i < 4; i++) await b.reverse(reorg({ outputIndex: i }));
      await b.reverse(reorg({ outputIndex: 2 }));
      const rows = await db.sql<Array<{ reversal_ledger_tx_id: string }>>`
        SELECT reversal_ledger_tx_id FROM pay.custody_deposits WHERE status = 'reversed' AND reversal_ledger_tx_id IS NOT NULL`;
      expect(rows).toHaveLength(4);
      expect(reversals()).toHaveLength(4);
      expect(new Set(rows.map((r) => r.reversal_ledger_tx_id)).size).toBe(4);
      expect(await balance()).toBe(0n);
      await b.receive(seen({ outputIndex: 7, confirmations: 1 }));
      await expect(
        db.sql`UPDATE pay.custody_deposits SET status = 'reversed', reversal_ledger_tx_id = 'x', reversed_at = now() WHERE output_index = 7`,
      ).rejects.toThrow();
      await expect(
        db.sql`UPDATE pay.custody_deposits SET credited_at = now(), ledger_tx_id = 'x' WHERE output_index = 7`,
      ).rejects.toThrow();
    });
  });

  describe('announcing a credit for the inbox (W-deposit-09)', () => {
    type Sent = Parameters<NonNullable<ConstructorParameters<typeof CustodyDepositBook>[0]['announceCredit']>>[0];
    const announcing = (sent: Sent[], failing: { on: boolean; tries?: number } = { on: false }) =>
      new CustodyDepositBook({
        sql: db.sql,
        postDeposit: async (input) => {
          const { networkId, txHash, outputIndex, ...rest } = input;
          return ledger.post(recipes.deposit({ ...rest, rail: 'crypto-native', railRef: `${networkId}:${txHash}:${outputIndex}` }));
        },
        registries: { listRoutableNetworks: async () => networks },
        announceCredit: async (credit) => {
          failing.tries = (failing.tries ?? 0) + 1;
          if (failing.on) throw new Error('bus unavailable');
          sent.push(credit);
        },
        log: (msg, extra) => logs.push({ msg, extra }),
      });
    const unannounced = async () =>
      (await db.sql<Array<{ id: string }>>`SELECT id FROM pay.custody_deposits WHERE status = 'credited' AND credit_notified_at IS NULL`)
        .length;

    it('announces a credit once, with its deposit, ledger transaction and time, and records it', async () => {
      const sent: Sent[] = [];
      const b = announcing(sent);
      expect(await b.receive(seen({ confirmations: 11 }))).toMatchObject({ status: 'confirming' });
      expect(sent).toHaveLength(0);
      await b.receive(seen());
      await b.receive(seen());
      await b.settleOpen();
      await b.announceOwed();
      const [row] = await db.sql<Array<{ id: string; ledger_tx_id: string; credited_at: Date; credit_notified_at: Date | null }>>`
        SELECT id, ledger_tx_id, credited_at, credit_notified_at FROM pay.custody_deposits`;
      expect(sent).toEqual([
        {
          depositId: row!.id,
          userId: ALICE,
          assetId: 'USDT',
          networkId: 'ethereum',
          amount: '25',
          txHash: TX.toLowerCase(),
          ledgerTxId: row!.ledger_tx_id,
          creditedAt: row!.credited_at.toISOString(),
        },
      ]);
      expect(row!.credit_notified_at).not.toBeNull();
      expect(posts()).toHaveLength(1);
    });

    it('a bus failure after the credit keeps the credit; the next pass announces it once', async () => {
      const sent: Sent[] = [];
      const failing = { on: true };
      const b = announcing(sent, failing);
      expect(await b.receive(seen())).toMatchObject({ status: 'credited' });
      expect(await balance()).toBe(parseAmount('25'));
      expect(await b.announceOwed()).toBe(0);
      expect(sent).toHaveLength(0);
      expect(await unannounced()).toBe(1);
      expect(logs.map((l) => l.msg)).toContain('custody deposit credit not announced yet');
      failing.on = false;
      expect(await b.announceOwed()).toBe(1);
      expect(await b.announceOwed()).toBe(0);
      expect(sent).toHaveLength(1);
      expect(await unannounced()).toBe(0);
      expect(posts()).toHaveLength(1);
    });

    it('a crash after publishing and before recording announces again under the same deposit id', async () => {
      const sent: Sent[] = [];
      const b = announcing(sent);
      await b.receive(seen());
      await b.announceOwed();
      await db.sql`UPDATE pay.custody_deposits SET credit_notified_at = NULL`;
      expect(await b.announceOwed()).toBe(1);
      expect(sent).toHaveLength(2);
      expect(sent[1]!.depositId).toBe(sent[0]!.depositId);
      expect(sent[1]).toEqual(sent[0]);
    });

    it('a credit does not wait for its announcement', async () => {
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      const sent: Sent[] = [];
      const b = new CustodyDepositBook({
        sql: db.sql,
        postDeposit: async (input) => {
          const { networkId, txHash, outputIndex, ...rest } = input;
          return ledger.post(recipes.deposit({ ...rest, rail: 'crypto-native', railRef: `${networkId}:${txHash}:${outputIndex}` }));
        },
        registries: { listRoutableNetworks: async () => networks },
        announceCredit: async (credit) => {
          await held;
          sent.push(credit);
        },
      });
      expect(await b.receive(seen())).toMatchObject({ status: 'credited' });
      expect(await balance()).toBe(parseAmount('25'));
      expect(sent).toHaveLength(0);
      release();
      expect(await b.announceOwed()).toBe(1);
      expect(sent).toHaveLength(1);
      expect(await unannounced()).toBe(0);
    });

    it('a bus that is down costs one failed publish per pass, not one per row, and overlapping calls share a pass', async () => {
      await book().receive(seen());
      await book().receive(seen({ outputIndex: 1 }));
      await book().receive(seen({ outputIndex: 2 }));
      const sent: Sent[] = [];
      const failing = { on: true, tries: 0 };
      const b = announcing(sent, failing);
      expect(await b.announceOwed()).toBe(0);
      expect(failing.tries).toBe(1);
      expect(await unannounced()).toBe(3);
      failing.on = false;
      failing.tries = 0;
      const [first, second] = await Promise.all([b.announceOwed(), b.announceOwed()]);
      expect(first).toBe(3);
      expect(second).toBe(3);
      expect(failing.tries).toBe(3);
      expect(sent.map((c) => c.depositId)).toHaveLength(3);
      expect(new Set(sent.map((c) => c.depositId)).size).toBe(3);
      expect(await unannounced()).toBe(0);
    });

    it('a row the event cannot carry is named and skipped; the rows after it are still announced', async () => {
      await book().receive(seen());
      await book().receive(seen({ outputIndex: 1 }));
      const [first] = await db.sql<Array<{ id: string }>>`
        SELECT id FROM pay.custody_deposits WHERE output_index = 0`;
      await db.sql`UPDATE pay.custody_deposits SET user_id = 'not-a-user-id' WHERE id = ${first!.id}`;
      const sent: Sent[] = [];
      expect(await announcing(sent).announceOwed()).toBe(1);
      expect(sent.map((c) => c.depositId)).not.toContain(first!.id);
      expect(logs).toContainEqual({
        msg: 'custody deposit credit cannot be announced',
        extra: { depositId: first!.id, fields: ['userId'] },
      });
      expect(await unannounced()).toBe(1);
    });

    it('with no publisher nothing is announced; credits wait and are announced once one is passed', async () => {
      await book().receive(seen());
      await book().receive(seen({ outputIndex: 1 }));
      expect(await unannounced()).toBe(2);
      const sent: Sent[] = [];
      expect(await announcing(sent).announceOwed()).toBe(2);
      expect(sent.map((c) => c.amount)).toEqual(['25', '25']);
      expect(await unannounced()).toBe(0);
    });

    it('the migration marks credits made before it as announced, so they are not told again', async () => {
      await book().receive(seen());
      expect(await unannounced()).toBe(1);
      const migration = readFileSync(join(drizzleDir, '20261024123500_pay_custody_deposit_credit_notice.sql'), 'utf8');
      await db.sql.unsafe(migration);
      expect(await unannounced()).toBe(0);
      const sent: Sent[] = [];
      expect(await announcing(sent).announceOwed()).toBe(0);
      expect(sent).toHaveLength(0);
    });
  });
});
