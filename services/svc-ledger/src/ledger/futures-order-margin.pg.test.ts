import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import {
  InsufficientFundsError,
  formatAmount,
  futuresOrderMarginAccount,
  parseAmount as amt,
  positionCollateralAccount,
  recipes,
  userAvailable,
} from '@intafaced/ledger-client';
import { PostgresLedger } from './postgres-ledger.js';

/**
 * Futures order margin (ADR 2026-10-20 slice 5) on the real ledger: the hold,
 * the fill that draws it into the position pot with the unused part returned
 * in the same posting, and the per-order isolation. No migration: the order
 * pot is a user hold row with its own purpose, upserted by the first hold.
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
const CHECK_VIOLATION = '23514';
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };

  try {
    const container = await new PostgreSqlContainer(H8A_IMAGE)
      .withDatabase('intafaced_order_margin_test')
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
      `H8a: futures order margin is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('futures order margin on the real ledger', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDb | undefined;
  let engine: PostgresLedger;

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDb({ service: 'ledger_order_margin', url: admin.url, migrations });
    engine = new PostgresLedger(db.sql);
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  const bal = async (account: Parameters<PostgresLedger['balance']>[0]): Promise<string> =>
    formatAmount((await engine.balance(account)).amount);

  it('holds, applies a fill with a returned remainder in one posting, and posts each key once', async () => {
    await engine.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('1000'), rail: 'crypto-native', railRef: 'tx-om-1' }));
    await engine.post(recipes.futuresOrderMarginHold({ orderId: 'o1', userId: USER, assetId: 'USDT', amount: amt('300') }));
    await engine.post(recipes.futuresOrderMarginHold({ orderId: 'o2', userId: USER, assetId: 'USDT', amount: amt('500') }));
    expect(await bal(userAvailable(USER, 'USDT'))).toBe('200');

    const apply = recipes.futuresOrderMarginApply({
      orderId: 'o1',
      userId: USER,
      assetId: 'USDT',
      positionId: 'pos-om-1',
      fillId: 'm1:1:pos-om-1',
      amount: amt('250'),
      releaseAmount: amt('50'),
    });
    await engine.post(apply);
    await engine.post(apply);

    expect(await bal(futuresOrderMarginAccount(USER, 'USDT', 'o1'))).toBe('0');
    expect(await bal(positionCollateralAccount(USER, 'USDT', 'pos-om-1'))).toBe('250');
    expect(await bal(userAvailable(USER, 'USDT'))).toBe('250');
    expect(await bal(futuresOrderMarginAccount(USER, 'USDT', 'o2'))).toBe('500');
  });

  it('refuses a release or a fill past what the one order holds, even with another order held', async () => {
    await expect(
      engine.post(recipes.futuresOrderMarginRelease({ orderId: 'o2', userId: USER, assetId: 'USDT', amount: amt('501') })),
    ).rejects.toBeInstanceOf(InsufficientFundsError);
    await expect(
      engine.post(
        recipes.futuresOrderMarginApply({
          orderId: 'o2',
          userId: USER,
          assetId: 'USDT',
          positionId: 'pos-om-2',
          fillId: 'm1:2:pos-om-2',
          amount: amt('400'),
          releaseAmount: amt('101'),
        }),
      ),
    ).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(await bal(futuresOrderMarginAccount(USER, 'USDT', 'o2'))).toBe('500');
    expect(await bal(positionCollateralAccount(USER, 'USDT', 'pos-om-2'))).toBe('0');
    expect(await bal(userAvailable(USER, 'USDT'))).toBe('250');
  });
});
