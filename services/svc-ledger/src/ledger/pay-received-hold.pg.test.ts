import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import {
  InsufficientFundsError,
  formatAmount,
  parseAmount as amt,
  payReceivedHoldAccount,
  recipes,
  userAvailable,
} from '@intafaced/ledger-client';
import { PostgresLedger } from './postgres-ledger.js';

/**
 * Holds on received funds (pay ENGINE-SPEC RH-1 to RH-4, PP-money-balance-05) on
 * the real ledger: one outcome per hold (release then return refused), per-hold
 * isolation, and each key posts once. No migration: the pot is a user hold row
 * with its own purpose `pay:recv:<holdId>`, upserted by the first hold.
 *
 * H8a PG-hard: this file never skips. CI uses TEST_DATABASE_URL. Local without
 * that env starts Testcontainers postgres:16-alpine.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');

const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'))
  .map((body) => (schema: string) => rewriteSchemaSql(body, 'ledger', schema));

if (migrations.length === 0) throw new Error(`No migrations found in ${drizzleDir}`);

const H8A_IMAGE = 'postgres:16-alpine';
const RECIPIENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PAYER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };

  try {
    const container = await new PostgreSqlContainer(H8A_IMAGE)
      .withDatabase('intafaced_pay_received_hold_test')
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
      `H8a: holds on received funds are PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('holds on received funds on the real ledger', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDb | undefined;
  let engine: PostgresLedger;

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDb({ service: 'ledger_pay_received_hold', url: admin.url, migrations });
    engine = new PostgresLedger(db.sql);
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  const bal = async (account: Parameters<PostgresLedger['balance']>[0]): Promise<string> =>
    formatAmount((await engine.balance(account)).amount);
  const hold = (holdId: string, amount: string) =>
    recipes.payReceivedHold({ holdId, userId: RECIPIENT, assetId: 'USDT', amount: amt(amount) });

  it('holds, releases once, and refuses a return after the release', async () => {
    await engine.post(
      recipes.deposit({ userId: RECIPIENT, assetId: 'USDT', amount: amt('1000'), rail: 'crypto-native', railRef: 'tx-rh-1' }),
    );
    await engine.post(hold('h1', '300'));
    await engine.post(hold('h1', '300'));
    await engine.post(hold('h2', '200'));
    expect(await bal(userAvailable(RECIPIENT, 'USDT'))).toBe('500');

    const release = recipes.payReceivedRelease({ holdId: 'h1', userId: RECIPIENT, assetId: 'USDT', amount: amt('300') });
    await engine.post(release);
    await engine.post(release);
    expect(await bal(userAvailable(RECIPIENT, 'USDT'))).toBe('800');
    expect(await bal(payReceivedHoldAccount(RECIPIENT, 'USDT', 'h1'))).toBe('0');

    await expect(
      engine.post(recipes.payReceivedReturn({ holdId: 'h1', userId: RECIPIENT, payerUserId: PAYER, assetId: 'USDT', amount: amt('300') })),
    ).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await bal(userAvailable(PAYER, 'USDT'))).toBe('0');
    expect(await bal(payReceivedHoldAccount(RECIPIENT, 'USDT', 'h2'))).toBe('200');
  });

  it('returns a hold to the payer once and never draws on another hold', async () => {
    await expect(
      engine.post(recipes.payReceivedRelease({ holdId: 'h2', userId: RECIPIENT, assetId: 'USDT', amount: amt('201') })),
    ).rejects.toBeInstanceOf(InsufficientFundsError);
    const giveBack = recipes.payReceivedReturn({
      holdId: 'h2',
      userId: RECIPIENT,
      payerUserId: PAYER,
      assetId: 'USDT',
      amount: amt('200'),
    });
    await engine.post(giveBack);
    await engine.post(giveBack);
    expect(await bal(userAvailable(PAYER, 'USDT'))).toBe('200');
    expect(await bal(payReceivedHoldAccount(RECIPIENT, 'USDT', 'h2'))).toBe('0');
    expect(await bal(userAvailable(RECIPIENT, 'USDT'))).toBe('800');
  });
});
