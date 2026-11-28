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
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { MemoryLedger, MoneyError, parseAmount, recipes } from '@intafaced/ledger-client';
import { MINING_EPOCH_PAYOUT_JOB, startMiningJobs } from './epoch-jobs.js';
import * as ledgerModule from './ledger.js';
import { buildPayoutRecipes, miningPayoutRewardId, postPayouts } from './ledger.js';
import { planPplns } from './pplns.js';
import * as submitShareModule from './submit-share.js';
import { handleSubmitSharePost, submitShare } from './submit-share.js';
import { EMISSION_UNPUBLISHED, EPOCH_UNSET } from './window-store.js';

/** Every call into the payout door (ledger.ts postPayouts), from any module in this service. */
const payoutDoor = vi.hoisted(() => ({ calls: 0 }));
vi.mock('./ledger.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./ledger.js')>();
  return {
    ...real,
    postPayouts: (...args: Parameters<typeof real.postPayouts>) => {
      payoutDoor.calls += 1;
      return real.postPayouts(...args);
    },
  };
});

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
    // The recipe it would post is the ledger-client's rewardPay at that exact amount, for that miner: never a mint.
    const built = buildPayoutRecipes({ ...window, reward: '2.5', feeBps: 0 });
    expect(built).toEqual([
      recipes.rewardPay({
        rewardId: miningPayoutRewardId('epoch-1', ALICE),
        userId: ALICE,
        assetId: 'IFC',
        amount: parseAmount('2.5'),
        reason: 'mining.pplns.payout',
      }),
    ]);
    // Every export of ledger.ts, called with a valid window: none of them posts.
    const calls: Record<string, () => unknown> = {
      miningPayoutRewardId: () => ledgerModule.miningPayoutRewardId('epoch-1', ALICE),
      miningPayoutIdempotencyKey: () => ledgerModule.miningPayoutIdempotencyKey('epoch-1', ALICE),
      buildPayoutRecipes: () => ledgerModule.buildPayoutRecipes(window),
      postPayouts: () => ledgerModule.postPayouts(ledger, window).catch((err: unknown) => err),
    };
    expect(Object.keys(ledgerModule).sort()).toEqual(Object.keys(calls).sort());
    for (const call of Object.values(calls)) await call();
    expect(posts).toEqual([]);
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

  it('only the JobHost tick reaches the payout door: every export of submit-share.ts persists without paying', async () => {
    const SECRET = 'q-mine-submit-share-secret-long-enough';
    const ledger = new MemoryLedger();
    const window = {
      windowId: 'epoch-doors',
      epoch: 1,
      assetId: 'IFC',
      reward: '10',
      feeBps: 100,
      shares: [{ shareId: 'd1', minerId: ALICE, weight: 1n }],
    };
    const body = Buffer.from(
      JSON.stringify({ ...window, windowId: 'epoch-doors-http', epoch: 2, shares: [{ shareId: 'd2', minerId: BOB, weight: '2' }] }),
      'utf8',
    );
    payoutDoor.calls = 0;
    const calls: Record<string, () => Promise<unknown>> = {
      MINING_UNAUTHENTICATED: async () => submitShareModule.MINING_UNAUTHENTICATED,
      authorizeSubmitShare: async () =>
        submitShareModule.authorizeSubmitShare(serviceAuthHeadersForBody('svc-cron', SECRET, body), SECRET, body),
      parsePplnsBody: async () => submitShareModule.parsePplnsBody(JSON.parse(body.toString('utf8'))),
      submitShare: () => submitShareModule.submitShare(sql, window),
      handleSubmitSharePost: async () => {
        const signed = await handleSubmitSharePost({
          headers: serviceAuthHeadersForBody('svc-cron', SECRET, body),
          rawBody: body,
          secret: SECRET,
          sql,
        });
        expect(signed.status).toBe(200);
        return signed;
      },
      ingestRigShare: () =>
        submitShareModule
          .ingestRigShare(sql, {}, { windowId: 'epoch-doors', assetId: 'IFC', minerId: ALICE, workerName: 'rig-1', powNonce: '00' })
          .catch((err: unknown) => err),
    };
    expect(Object.keys(submitShareModule).sort()).toEqual(Object.keys(calls).sort());
    for (const call of Object.values(calls)) await call();
    const stored = await sql<{ window_id: string }[]>`SELECT DISTINCT window_id FROM mining_pool.shares ORDER BY window_id`;
    expect(stored.map((row) => row.window_id)).toEqual(['epoch-doors', 'epoch-doors-http']);
    expect(payoutDoor.calls).toBe(0);
    expect(ledger.journal()).toHaveLength(0);

    // The JobHost tick is the door that does reach it (and it still refuses, posting nothing).
    const clock = captureIntervals();
    const handle = startMiningJobs({
      sql,
      ledger,
      intervalMs: 15_000,
      setIntervalFn: clock.setIntervalFn,
      clearIntervalFn: clock.clearIntervalFn,
      onError: () => undefined,
    });
    await clock.timers[0]!.fn();
    expect(payoutDoor.calls).toBeGreaterThan(0);
    expect(ledger.journal()).toHaveLength(0);
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
