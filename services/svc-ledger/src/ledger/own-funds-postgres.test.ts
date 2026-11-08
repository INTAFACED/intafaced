import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import {
  burnAccount,
  formatAmount,
  houseFees,
  insuranceFund,
  marketMaker,
  merchantClearing,
  moduleAccount,
  parseAmount as amt,
  railBoundary,
  userAvailable,
} from '@intafaced/ledger-client';
import { PostgresLedger } from './postgres-ledger.js';
import { disableBalanceTrigger } from '../db/journal-guards.testkit.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');

const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'))
  .map((body) => (schema: string) => rewriteSchemaSql(body, 'ledger', schema));

const PAYER = '11111111-1111-4111-8111-111111111111';

const MERCHANT = '22222222-2222-4222-8222-222222222222';

const H8A_IMAGE = 'postgres:16-alpine';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
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
      `H8a: ledger history is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('PostgresLedger.ownFunds (J-ops-console-24 #1)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDb | undefined;
  let engine: PostgresLedger;

  const move = (key: string, from: Parameters<typeof engine.post>[0]['entries'][number]['account'], to: typeof from, value: string) => ({
    idempotencyKey: key,
    module: 'bank',
    reason: 'test.move',
    entries: [
      { account: to, direction: 'debit' as const, amount: amt(value) },
      { account: from, direction: 'credit' as const, amount: amt(value) },
    ],
  });

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDb({ service: 'ledger_own_funds', url: admin.url, migrations });
    await disableBalanceTrigger(db.sql);
    engine = new PostgresLedger(db.sql);
    const rail = railBoundary('crypto-native', 'USDT');
    // A customer's money, a merchant's money, and tokens burned: none of it is ours.
    await engine.post(move('own-funds-user', rail, userAvailable(PAYER, 'USDT'), '1000'));
    await engine.post(move('own-funds-merchant', rail, merchantClearing(MERCHANT, 'USDT'), '40'));
    await engine.post(move('own-funds-burn', rail, burnAccount('USDT'), '5'));
    // INTAFACED's own: a fee pot, the insurance fund, the market maker's inventory and a module reserve.
    await engine.post(move('own-funds-fee', userAvailable(PAYER, 'USDT'), houseFees('trade', 'USDT'), '12.500000000000000001'));
    await engine.post(move('own-funds-insurance', rail, insuranceFund('USDT'), '77'));
    await engine.post(move('own-funds-mm', railBoundary('crypto-native', 'BTC'), marketMaker('BTC'), '0.25'));
    await engine.post(move('own-funds-reserve', rail, moduleAccount('bank', 'loan-reserve', 'USDT'), '300'));
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  it('answers every house and module account with a balance, to 18 decimals, and nothing a customer holds', async () => {
    const { asOf, rows } = await engine.ownFunds();
    expect(Number.isNaN(asOf.getTime())).toBe(false);
    expect(rows.map((r) => [r.assetId, r.ownerType, r.ownerId, r.kind, formatAmount(r.balance)])).toEqual([
      ['BTC', 'house', 'market-maker', 'available', '0.25'],
      ['USDT', 'house', 'fees:trade', 'available', '12.500000000000000001'],
      ['USDT', 'house', 'insurance-fund', 'available', '77'],
      ['USDT', 'module', 'bank:loan-reserve', 'available', '300'],
    ]);
  });

  it('leaves out the user, the merchant clearing pot, the burn account and every treasury boundary', async () => {
    const { rows } = await engine.ownFunds();
    const owners = rows.map((r) => r.ownerId);
    expect(owners).not.toContain(PAYER);
    expect(owners.some((o) => o.startsWith('pay:clearing:'))).toBe(false);
    expect(owners).not.toContain('burn');
    expect(rows.every((r) => r.ownerType === 'house' || r.ownerType === 'module')).toBe(true);
  });
});
