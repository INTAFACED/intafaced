import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { InsufficientFundsError, formatAmount, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';
import { PostgresLedger } from './postgres-ledger.js';

/**
 * Consented reversal of a posted internal send (BK-xfer-09) on the real ledger:
 * a new posting back to the sender, one per original firing, refused when the
 * recipient no longer holds the funds. No migration.
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
const SENDER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RECIPIENT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };

  try {
    const container = await new PostgreSqlContainer(H8A_IMAGE)
      .withDatabase('intafaced_bank_transfer_reversal_test')
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
      `H8a: consented reversal is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('consented reversal on the real ledger', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDb | undefined;
  let engine: PostgresLedger;

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDb({ service: 'ledger_bank_transfer_reversal', url: admin.url, migrations });
    engine = new PostgresLedger(db.sql);
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  const bal = async (account: Parameters<PostgresLedger['balance']>[0]): Promise<string> =>
    formatAmount((await engine.balance(account)).amount);
  const from = userAvailable(SENDER, 'USDT');
  const to = userAvailable(RECIPIENT, 'USDT');
  const reversal = (transferId: string, amount: string) =>
    recipes.bankTransferReversal({
      transferId,
      occurrence: 0,
      consentId: `c-${transferId}`,
      originalFrom: from,
      originalTo: to,
      amount: amt(amount),
    });

  it('reverses a posted send once with consent', async () => {
    await engine.post(
      recipes.deposit({ userId: SENDER, assetId: 'USDT', amount: amt('1000'), rail: 'crypto-native', railRef: 'tx-rev-1' }),
    );
    await engine.post(
      recipes.bankTransfer({ transferId: 't1', occurrence: 0, from, to, amount: amt('100'), kind: 'manual', keySpace: 'p2p' }),
    );
    await engine.post(reversal('t1', '100'));
    await engine.post(reversal('t1', '100'));
    expect(await bal(from)).toBe('1000');
    expect(await bal(to)).toBe('0');
  });

  it('refuses a reversal the recipient can no longer fund and moves nothing', async () => {
    await engine.post(
      recipes.bankTransfer({ transferId: 't2', occurrence: 0, from, to, amount: amt('50'), kind: 'manual', keySpace: 'p2p' }),
    );
    await expect(engine.post(reversal('t2', '60'))).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await bal(from)).toBe('950');
    expect(await bal(to)).toBe('50');
  });
});
