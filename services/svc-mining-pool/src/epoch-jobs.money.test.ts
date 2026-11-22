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
import { MemoryLedger } from '@intafaced/ledger-client';
import { MINING_EPOCH_PAYOUT_JOB, startMiningJobs } from './epoch-jobs.js';
import { submitShare } from './submit-share.js';

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

  it('HTTP submitShare persists only; JobHost is the payout door and refuses unpublished mint/reward', () => {
    const submitSrc = readFileSync(join(here, 'submit-share.ts'), 'utf8');
    const jobsSrc = readFileSync(join(here, 'epoch-jobs.ts'), 'utf8');
    const serverSrc = readFileSync(join(here, 'server.ts'), 'utf8');
    const ledgerSrc = readFileSync(join(here, 'ledger.ts'), 'utf8');
    const pplnsSrc = readFileSync(join(here, 'pplns.ts'), 'utf8');
    expect(submitSrc).not.toMatch(/postPayouts/);
    expect(submitSrc).toMatch(/persistWindowShares/);
    expect(jobsSrc).toMatch(/postPayouts/);
    expect(jobsSrc).toMatch(/createJobHost/);
    expect(jobsSrc).toMatch(/EMISSION_UNPUBLISHED/);
    expect(serverSrc).toMatch(/startMiningJobs/);
    expect(serverSrc).not.toMatch(/postPayouts/);
    expect(ledgerSrc).toMatch(/parseAmount\(payout\.amount\)/);
    expect(ledgerSrc).toMatch(/parseAmount\(input\.reward\)/);
    expect(ledgerSrc).toMatch(/EMISSION_UNPUBLISHED/);
    expect(ledgerSrc).not.toMatch(/mintEmission/);
    expect(ledgerSrc).not.toMatch(/ledger\.post/);
    expect(pplnsSrc).toMatch(/parseAmount\(input\.reward\)/);
    expect(pplnsSrc).not.toMatch(/Number\(input\.reward\)/);
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
