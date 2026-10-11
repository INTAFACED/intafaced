import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, formatAmount, parseAmount as amt, recipes, userAvailable } from '@intafaced/ledger-client';
import { DEFAULT_BUYBACK_PARAMS } from './economics/buyback.js';
import { DEFAULT_EMISSION_PARAMS } from './economics/emission.js';
import { TokenService } from './token-service.js';

/**
 * L351. An insert that omits `token.stakes.status` must not be yield-eligible.
 *
 * The funded row is opened through `stake` (ledger post, then active). The
 * second insert omits status. Yield pays only the funded row. Re-applying the
 * ups after that funded row exists must not rewrite it to pending.
 *
 * PG-hard: no `describe.skip`. `TEST_DATABASE_URL` is the admin URL for a
 * per-run database. Docker down and no URL is a failed suite.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((file) => file.endsWith('.sql') && !file.endsWith('.down.sql'))
  .sort()
  .map((file) => readFileSync(join(drizzleDir, file), 'utf8'));

const FUNDED = '11111111-1111-4111-8111-111111111111';
const OMITTED = '44444444-4444-4444-8444-444444444444';
const FUNDED_STAKE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
/** Decimal string. The omitted row is not a ledger principal. */
const STAKE_AMOUNT = '1000';
const YIELD_AMOUNT = '100';

const H8A_IMAGE = 'postgres:16-alpine';

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };

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
      `L351 stake default test is PG-hard (a skip is not a pass). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

describe('L351 omitted stake status', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'token', url: admin.url, migrations });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  it('an insert that omits status is not yield-eligible', async () => {
    const sql = db.sql;
    await sql`TRUNCATE token.governance_votes, token.proposals, token.stakes, token.buyback_runs, token.emission_epochs, token.yield_payouts, token.yield_windows RESTART IDENTITY CASCADE`;

    const ledger = new MemoryLedger();
    const bus = new MemoryEventBus('svc-token');
    const token = new TokenService(sql, ledger, bus, {
      assetId: 'IFC',
      emission: DEFAULT_EMISSION_PARAMS,
      buyback: DEFAULT_BUYBACK_PARAMS,
      loadParamsFromDb: false,
    });
    const balanceOf = async (userId: string) => formatAmount((await ledger.balance(userAvailable(userId, 'IFC'))).amount);

    await ledger.post(
      recipes.deposit({
        userId: FUNDED,
        assetId: 'IFC',
        amount: amt(STAKE_AMOUNT),
        rail: 'test',
        railRef: `${FUNDED}:${STAKE_AMOUNT}:l351`,
      }),
    );
    const opened = await token.stake({
      userId: FUNDED,
      amount: amt(STAKE_AMOUNT),
      tier: 'flex',
      stakeId: FUNDED_STAKE_ID,
    });
    expect(opened.status).toBe('active');

    // 0000 is CREATE TABLE IF NOT EXISTS. A book that already applied it will
    // not pick up a new default from that file. Re-applying the ups here is
    // the later migration, and it must leave this active row active.
    for (const migration of migrations) {
      await sql.unsafe(migration);
    }

    const kept = await sql<Array<{ status: string }>>`SELECT status FROM token.stakes WHERE id = ${opened.id}`;
    expect(kept[0]?.status).toBe('active');

    await sql`
      INSERT INTO token.stakes (user_id, amount, tier, multiplier_bps)
      VALUES (${OMITTED}, ${STAKE_AMOUNT}::numeric, 'flex', ${'10000'}::numeric)
    `;

    const payer = '99999999-9999-4999-8999-999999999999';
    await ledger.post(
      recipes.deposit({
        userId: payer,
        assetId: 'IFC',
        amount: amt(YIELD_AMOUNT),
        rail: 'test',
        railRef: `${payer}:${YIELD_AMOUNT}:l351`,
      }),
    );
    await ledger.post(
      recipes.feeCharge({
        chargeId: 'l351-trade-fee',
        userId: payer,
        module: 'trade',
        mode: 'asset',
        assetId: 'IFC',
        amount: amt(YIELD_AMOUNT),
      }),
    );

    const result = await token.distributeRevenue({
      windowId: 'l351-omit-status',
      sources: [{ module: 'trade', amount: amt(YIELD_AMOUNT) }],
    });

    expect(await balanceOf(OMITTED)).toBe('0');
    expect(await balanceOf(FUNDED)).toBe(YIELD_AMOUNT);
    expect(result.recipients).toBe(1);
    expect(formatAmount(result.distributed)).toBe(YIELD_AMOUNT);

    const omitted = await sql<Array<{ status: string }>>`SELECT status FROM token.stakes WHERE user_id = ${OMITTED}`;
    expect(omitted).toHaveLength(1);
    expect(omitted[0]?.status).toBe('pending');
  });
});
