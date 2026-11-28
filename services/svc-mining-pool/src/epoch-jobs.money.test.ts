/**
 * Q-mine money proof — mining-pool JobHost + PG mint/rewardPay.
 *
 * PG-hard: never `describe.skip` / `postgresAvailable`. CI uses TEST_DATABASE_URL.
 * Local without that env starts Testcontainers `postgres:16-alpine`. Docker/PG
 * down is a failed suite, not a green skip.
 *
 * JobHost tick loads open windows from SQL. Epoch unset → mining.epoch_unset.
 * Epoch set still refuses mining.emission_unpublished (token is the only minter;
 * caller reward is not owner law). Zero mint/rewardPay either way. Amounts are
 * decimal strings / scaled bigint — never JS number.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testPostgres } from '@intafaced/db/test-postgres';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryLedger, MoneyError, parseAmount } from '@intafaced/ledger-client';
import { MINING_EPOCH_PAYOUT_JOB, startMiningJobs } from './epoch-jobs.js';
import { buildPayoutRecipes, postPayouts } from './ledger.js';
import { planPplns } from './pplns.js';
import { submitShare } from './submit-share.js';
import { EMISSION_UNPUBLISHED, EPOCH_UNSET } from './window-store.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const Q_MINE_IMAGE = 'postgres:16-alpine';

async function openQMineAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) {
    return { url: envUrl, stop: async () => undefined };
  }
  try {
    const container = await testPostgres(Q_MINE_IMAGE)
      .withDatabase('intafaced_qmine_test')
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
      `Q-mine: mining JobHost is PG-hard (no skip-green). ` +
        `TEST_DATABASE_URL unset and Testcontainers could not start ${Q_MINE_IMAGE}: ${msg}`,
    );
  }
}

function captureIntervals() {
  const timers: Array<{ id: number; fn: () => unknown; ms: number }> = [];
  let nextId = 1;
  return {
    timers,
    setIntervalFn: ((fn: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ id, fn, ms });
      return id as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearIntervalFn: ((id: number) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    }) as typeof clearInterval,
  };
}

describe('Q-mine JobHost money hitch (source)', () => {
  it('Q-mine money suite is not skip-green (no postgresAvailable / describe.skip)', () => {
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(src).not.toMatch(/\bpostgresAvailable\s*\(/);
    expect(src).not.toMatch(/describe\.skip\s*\(/);
    expect(src).not.toMatch(/\bit\.skip\s*\(/);
  });

  it('the payout door refuses unpublished mint/reward and never posts; amounts are decimal strings, never numbers', async () => {
    const posts: unknown[] = [];
    const ledger = {
      post: async (request: unknown): Promise<never> => {
        posts.push(request);
        throw new Error('TEST: no post');
      },
    };
    const window = {
      windowId: 'epoch-1',
      epoch: 1,
      assetId: 'IFC',
      reward: '10',
      feeBps: 100,
      shares: [{ shareId: 'a', minerId: ALICE, weight: 1n }],
    };
    // An owner-unpublished emission refuses by name even with a set epoch and a caller reward (ledger.ts).
    await expect(postPayouts(ledger, window)).rejects.toThrow(EMISSION_UNPUBLISHED);
    const { epoch: _unset, ...noEpoch } = window;
    await expect(postPayouts(ledger, noEpoch)).rejects.toThrow(EPOCH_UNSET);
    // The reward is parsed as a decimal string: an exponent or a lossy figure refuses before anything else.
    for (const reward of ['1e1', '10.0000000000000000001', 'ten']) {
      await expect(postPayouts(ledger, { ...window, reward })).rejects.toThrow(MoneyError);
      expect(() => planPplns({ ...window, reward })).toThrow(MoneyError);
    }
    expect(posts).toEqual([]);
    // A reward a JS number cannot hold is paid out exactly (pplns.ts keeps it a scaled bigint).
    const plan = planPplns({ ...window, reward: '123456789012345678.000000000000000001', feeBps: 0 });
    expect(plan.gross).toBe('123456789012345678.000000000000000001');
    expect(plan.payouts).toEqual([{ minerId: ALICE, amount: '123456789012345678.000000000000000001' }]);
    // The recipe it would post is the ledger-client's rewardPay at that exact amount, for that miner.
    const [recipe] = buildPayoutRecipes({ ...window, reward: '2.5', feeBps: 0 });
    const posted = JSON.stringify(recipe, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
    expect(posted).toContain(String(parseAmount('2.5')));
    expect(posted).toContain(ALICE);
  });
});

describe('svc-mining-pool JobHost mint/rewardPay money', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;
  let sql: TestDatabase['sql'];

  beforeAll(async () => {
    const admin = await openQMineAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'mining_pool', url: admin.url, migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  beforeEach(async () => {
    await sql`TRUNCATE mining_pool.shares, mining_pool.windows RESTART IDENTITY CASCADE`;
  });

  it('JobHost+PG with epoch set still refuses unpublished mint/reward; window stays open', async () => {
    const ledger = new MemoryLedger();
    const plan = await submitShare(sql, {
      windowId: 'epoch-1',
      epoch: 1,
      assetId: 'IFC',
      reward: '10',
      feeBps: 100,
      shares: [
        { shareId: 'a', minerId: ALICE, weight: 1n },
        { shareId: 'b', minerId: BOB, weight: 3n },
      ],
    });
    expect(plan.payouts).toEqual([
      { minerId: ALICE, amount: '2.475' },
      { minerId: BOB, amount: '7.425' },
    ]);
    expect(ledger.journal()).toHaveLength(0);

    const clock = captureIntervals();
    const errors: string[] = [];
    const handle = startMiningJobs({
      sql,
      ledger,
      intervalMs: 15_000,
      setIntervalFn: clock.setIntervalFn,
      clearIntervalFn: clock.clearIntervalFn,
      onError: (_name, err) => errors.push(err instanceof Error ? err.message : String(err)),
    });
    expect(handle.host.list()).toContain(MINING_EPOCH_PAYOUT_JOB);
    await clock.timers[0]!.fn();

    expect(errors).toContain('mining.emission_unpublished');
    expect(ledger.journal()).toHaveLength(0);
    const [row] = await sql<{ status: string }[]>`SELECT status FROM mining_pool.windows WHERE window_id = 'epoch-1'`;
    expect(row?.status).toBe('open');
    handle.stop();
  });

  it('unset epoch on JobHost refuses; PG window stays open; zero mint', async () => {
    const ledger = new MemoryLedger();
    await submitShare(sql, {
      windowId: 'epoch-unset',
      assetId: 'IFC',
      reward: '10',
      feeBps: 100,
      shares: [{ shareId: 'a', minerId: ALICE, weight: 1n }],
    });
    const clock = captureIntervals();
    const errors: string[] = [];
    const handle = startMiningJobs({
      sql,
      ledger,
      intervalMs: 15_000,
      setIntervalFn: clock.setIntervalFn,
      clearIntervalFn: clock.clearIntervalFn,
      onError: (_name, err) => errors.push(err instanceof Error ? err.message : String(err)),
    });
    await clock.timers[0]!.fn();
    expect(errors).toContain('mining.epoch_unset');
    expect(ledger.journal()).toHaveLength(0);
    const [row] = await sql<{ status: string; epoch: number | null }[]>`
      SELECT status, epoch FROM mining_pool.windows WHERE window_id = 'epoch-unset'
    `;
    expect(row?.status).toBe('open');
    expect(row?.epoch).toBeNull();
    handle.stop();
  });
});
