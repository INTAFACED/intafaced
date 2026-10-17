import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import { InsufficientFundsError, formatAmount, merchantProceeds, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { PostgresLedger } from './postgres-ledger.js';

/**
 * The proceeds account is a module row the first settlement upserts.
 * No new owner type, no new account kind, and a debit past zero fails the
 * non-negative check. There is no migration for this account.
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
const MERCHANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };

  try {
    const container = await new PostgreSqlContainer(H8A_IMAGE)
      .withDatabase('intafaced_proceeds_test')
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
      `H8a: merchant proceeds is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('merchant proceeds PG-hard (source)', () => {
  it('is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });
});

describe('merchant proceeds account identity', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDb | undefined;
  let engine: PostgresLedger;

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDb({ service: 'ledger_proceeds', url: admin.url, migrations });
    engine = new PostgresLedger(db.sql);
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  it('upserts a module proceeds row and refuses a debit past zero', async () => {
    if (!db) throw new Error('H8a: test db not opened');
    await engine.post(
      recipes.paymentCapture({
        paymentId: 'pay-proceeds-pg',
        merchantId: MERCHANT,
        assetId: 'USDT',
        amount: amt('100'),
        rail: 'card-sandbox',
        railRef: 'ch_proceeds_pg',
      }),
    );
    await engine.post(
      recipes.merchantSettlement({
        merchantId: MERCHANT,
        merchantUserId: OWNER,
        window: '2026-10-16',
        assetId: 'USDT',
        gross: amt('100'),
        fee: amt('2.5'),
      }),
    );

    const rows = await db.sql<Array<{ owner_type: string; owner_id: string; kind: string; purpose: string; balance: string }>>`
      SELECT owner_type, owner_id, kind, purpose, balance::text
        FROM accounts
       WHERE owner_id = ${`pay:proceeds:${MERCHANT}`}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      owner_type: 'module',
      owner_id: `pay:proceeds:${MERCHANT}`,
      kind: 'available',
      purpose: '',
    });
    expect(rows[0]!.balance).toMatch(/^97\.50*$/);
    expect(merchantProceeds(MERCHANT, 'USDT')).toMatchObject({
      ownerType: 'module',
      ownerId: `pay:proceeds:${MERCHANT}`,
      kind: 'available',
    });

    const personal = await db.sql<Array<{ id: string }>>`
      SELECT id FROM accounts WHERE owner_type = 'user' AND owner_id = ${OWNER}
    `;
    expect(personal).toEqual([]);

    await expect(
      engine.post(
        recipes.merchantProceedsPayoutHold({
          merchantId: MERCHANT,
          assetId: 'USDT',
          amount: amt('100'),
          rail: 'crypto-native',
          withdrawalId: 'overdraft:0',
        }),
      ),
    ).rejects.toBeInstanceOf(InsufficientFundsError);
    expect(formatAmount((await engine.balance(merchantProceeds(MERCHANT, 'USDT'))).amount)).toBe('97.5');

    await expect(
      db.sql`
        UPDATE accounts
           SET balance = -1
         WHERE owner_id = ${`pay:proceeds:${MERCHANT}`}
      `,
    ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    expect(formatAmount((await engine.balance(merchantProceeds(MERCHANT, 'USDT'))).amount)).toBe('97.5');
  });
});
