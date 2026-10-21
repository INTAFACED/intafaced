import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryLedger, parseAmount, recipes, userAvailable } from '@intafaced/ledger-client';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NetworkState } from '../../registries/policy.js';
import { CustodyDepositBook } from './book.js';

/** Reorg reversal of credited customer deposits against a real Postgres and the memory ledger. TEST figures only. */
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
    .withDatabase('intafaced_custody_reorg_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const ALICE = '11111111-1111-4111-8111-111111111111';
const NETWORK = 'ethereum';
const ADDRESS = '0x00000000000000000000000000000000000000a1';
const TX = '0xabc0000000000000000000000000000000000000000000000000000000000001';
const HASH_A = '0xaaaa000000000000000000000000000000000000000000000000000000000001';
const HASH_B = '0xbbbb000000000000000000000000000000000000000000000000000000000002';

describe('custody deposit reorg reversal (real Postgres, memory ledger)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let ledger!: MemoryLedger;
  /** When set, the reverse post reaches the ledger and then loses its answer. */
  let loseAnswer = false;
  const logs: Array<{ msg: string; extra?: Record<string, unknown> }> = [];

  const book = () =>
    new CustodyDepositBook({
      sql: db.sql,
      postDeposit: async (input) => {
        const { networkId, txHash, outputIndex, ...rest } = input;
        return ledger.post(recipes.deposit({ ...rest, rail: 'crypto-native', railRef: `${networkId}:${txHash}:${outputIndex}` }));
      },
      reverseDeposit: async (input) => {
        const { networkId, txHash, outputIndex, ...rest } = input;
        const railRef = `${networkId}:${txHash}:${outputIndex}`;
        const tx = await ledger.post(recipes.depositReverse({ ...rest, rail: 'crypto-native', railRef, depositId: railRef }));
        if (loseAnswer) throw new Error('ledger timeout');
        return tx;
      },
      registries: {
        listRoutableNetworks: async () => [
          { networkId: NETWORK, displayName: 'Ethereum', assetCodes: ['USDT'], confirmationsRequired: 3, enabled: true } as NetworkState,
        ],
      },
      log: (msg, extra) => logs.push({ msg, extra }),
    });
  const seen = (over: Partial<Parameters<CustodyDepositBook['receive']>[0]> = {}) => ({
    address: ADDRESS,
    txHash: TX,
    outputIndex: 0,
    assetId: 'USDT',
    amount: parseAmount('25'),
    confirmations: 5,
    blockHeight: 100n,
    blockHash: HASH_A,
    ...over,
  });
  const balance = async () => (await ledger.balance(userAvailable(ALICE, 'USDT'))).amount;
  const reversals = () => ledger.journal().filter((t) => t.reason === 'deposit.reversed');
  const row = async () =>
    (
      await db.sql<
        Array<{
          status: string;
          reason: string | null;
          block_hash: string | null;
          reversal_ledger_tx_id: string | null;
          reversal_started_at: Date | null;
        }>
      >`
        SELECT status, reason, block_hash, reversal_ledger_tx_id, reversal_started_at FROM pay.custody_deposits`
    )[0]!;

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
    ledger = new MemoryLedger();
    loseAnswer = false;
    logs.length = 0;
    await db.sql`TRUNCATE pay.custody_deposits, pay.custody_deposit_settings, pay.custody_deposit_addresses`;
    await db.sql`INSERT INTO pay.custody_deposit_addresses (user_id, asset_id, network_id, address) VALUES (${ALICE}, 'USDT', ${NETWORK}, ${ADDRESS})`;
    await db.sql`
      INSERT INTO pay.custody_deposit_settings (asset_id, network_id, label, minimum_deposit, estimated_arrival_minutes, enabled, set_by)
      VALUES ('USDT', ${NETWORK}, 'TEST network', '10', 5, true, 'test-profile')`;
  }, 30_000);

  const gone = (over: Partial<{ txHash: string; outputIndex: number }> = {}) => [
    { address: ADDRESS, txHash: TX, outputIndex: 0, assetId: 'USDT', ...over },
  ];

  it('stores the block a credit was read from', async () => {
    await book().receive(seen());
    expect(await row()).toMatchObject({ status: 'credited', block_hash: HASH_A });
    await book().receive(seen());
    expect(reversals()).toHaveLength(0);
    expect(await balance()).toBe(parseAmount('25'));
  });

  it('a transfer re-mined in another block at the same index keeps its credit and updates the stored block', async () => {
    await book().receive(seen());
    const outcome = await book().receive(seen({ blockHash: HASH_B, blockHeight: 101n }));
    expect(outcome).toEqual({ state: 'recorded', status: 'credited', reason: null });
    expect(await row()).toMatchObject({ status: 'credited', block_hash: HASH_B });
    expect(reversals()).toHaveLength(0);
    expect(await balance()).toBe(parseAmount('25'));
  });

  it('a transfer the chain no longer reports is reversed once, also twice and after a restart', async () => {
    await book().receive(seen());
    expect(await book().dropped(gone())).toBe(1);
    expect(await book().dropped(gone())).toBe(0);
    expect(await book().dropped(gone())).toBe(0);
    expect(reversals()).toHaveLength(1);
    expect(reversals()[0]!.idempotencyKey).toBe(`deposit.reverse:${NETWORK}:${TX}:0`);
    expect(await balance()).toBe(0n);
    expect(await row()).toMatchObject({ status: 'reversed', reason: 'chain_reorg' });
    expect((await row()).reversal_ledger_tx_id).toBeTruthy();
    // The same transfer seen again does not bring the credit back, and does not reverse it twice.
    await book().receive(seen());
    expect(reversals()).toHaveLength(1);
    expect(await balance()).toBe(0n);
  });

  it('a pending deposit that is dropped is left alone, and a drop for another asset or index touches nothing', async () => {
    const b = book();
    await b.receive(seen());
    await b.receive(seen({ txHash: `0x${'d'.repeat(64)}`, confirmations: 1, blockHash: HASH_A }));
    expect(await b.dropped(gone({ txHash: `0x${'d'.repeat(64)}` }))).toBe(0);
    expect(await b.dropped([{ address: ADDRESS, txHash: TX, outputIndex: 0, assetId: 'DAI' }])).toBe(0);
    expect(await b.dropped(gone({ outputIndex: 7 }))).toBe(0);
    expect(reversals()).toHaveLength(0);
    const rows = await db.sql<Array<{ status: string }>>`SELECT status FROM pay.custody_deposits`;
    expect(rows.map((r) => r.status).sort()).toEqual(['confirming', 'credited']);
  });

  it('funds already spent: needs_review with an alert, no negative balance, no reversal', async () => {
    await book().receive(seen());
    await ledger.post(
      recipes.withdrawHold({ userId: ALICE, assetId: 'USDT', amount: parseAmount('20'), rail: 'crypto-native', withdrawalId: 'w-1' }),
    );
    expect(await book().dropped(gone())).toBe(0);
    expect(await row()).toMatchObject({ status: 'needs_review', reason: 'reversal_unfunded' });
    expect(reversals()).toHaveLength(0);
    expect(await balance()).toBe(parseAmount('5'));
    expect(logs.some((l) => l.extra?.alert === true && l.msg.includes('not covered'))).toBe(true);
  });

  it('a crash after the ledger post and before the row flip is finished under the same key', async () => {
    await book().receive(seen());
    loseAnswer = true;
    expect(await book().dropped(gone())).toBe(0);
    expect(await row()).toMatchObject({ status: 'credited' });
    expect((await row()).reversal_started_at).not.toBeNull();
    expect(logs.some((l) => l.msg.includes('left pending'))).toBe(true);
    loseAnswer = false;
    expect(await book().resumeReversals()).toBe(1);
    expect(await book().resumeReversals()).toBe(0);
    expect(await row()).toMatchObject({ status: 'reversed' });
    expect(reversals()).toHaveLength(1);
    expect(await balance()).toBe(0n);
  });

  it('a reversal that was started is also finished when the transfer is seen again', async () => {
    await book().receive(seen());
    loseAnswer = true;
    await book().dropped(gone());
    loseAnswer = false;
    expect(await book().receive(seen())).toEqual({ state: 'recorded', status: 'reversed', reason: 'chain_reorg' });
    expect(reversals()).toHaveLength(1);
  });

  it('a pending deposit that moves block is judged on the new depth and block, and credits nothing early', async () => {
    const b = book();
    await b.receive(seen({ confirmations: 1 }));
    await b.receive(seen({ confirmations: 1, blockHash: HASH_B, blockHeight: 101n }));
    expect(await row()).toMatchObject({ status: 'confirming', block_hash: HASH_B });
    expect(await balance()).toBe(0n);
    expect(await b.receive(seen({ blockHash: HASH_B, blockHeight: 101n }))).toMatchObject({ status: 'credited' });
    expect(reversals()).toHaveLength(0);
  });

  it('a row credited before block hashes were stored gets its block filled in and is not reversed', async () => {
    await book().receive(seen({ blockHash: null, blockHeight: null }));
    expect((await row()).block_hash).toBeNull();
    await book().receive(seen({ blockHash: HASH_B }));
    expect(reversals()).toHaveLength(0);
    expect(await row()).toMatchObject({ status: 'credited', block_hash: HASH_B });
  });
});
