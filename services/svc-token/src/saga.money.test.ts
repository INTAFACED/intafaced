/**
 * SAGATEST for svc-token's money doors: open a stake, close a stake, and mint an epoch. Each is replayed by
 * `describeMoneyDoor` as a duplicate request, a lost acknowledgement on the post, and a crash after the post, and the
 * ledger must end with the book of one clean run every time.
 *
 * Each door is driven the way a retry drives it: the same stake id, the same epoch. A stake or epoch already closed is left alone.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { verifyServiceHeaders } from '@intafaced/contracts';
import { MemoryLedger, parseAmount as amt, recipes, type LedgerClient } from '@intafaced/ledger-client';
import { describeMoneyDoor, type MoneyDoorScenario } from '@intafaced/ledger-client/testing/saga';
import { createLedgerClient } from './ledger-client.js';
import { TokenError, TokenService } from './token-service.js';
import { DEFAULT_BUYBACK_PARAMS } from './economics/buyback.js';
import { DEFAULT_EMISSION_PARAMS } from './economics/emission.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SECRET = 'svc-token-test-internal-secret-0123456789';
const USER = '11111111-1111-4111-8111-111111111111';
const STAKE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const options = {
  assetId: 'IFC',
  emission: DEFAULT_EMISSION_PARAMS,
  buyback: DEFAULT_BUYBACK_PARAMS,
  loadParamsFromDb: false,
  feeScheduleTtlMs: 0,
  emissionEpochMs: 0,
  governanceQuorumBps: 1000,
  governanceThresholdBps: 5000,
};

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_saga_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

let db: TestDatabase | undefined;
let stop: () => Promise<void> = async () => undefined;

beforeAll(async () => {
  const admin = await openAdmin();
  stop = admin.stop;
  db = await createTestDatabase({ service: 'token', url: admin.url, migrations });
}, 120_000);

afterAll(async () => {
  await db?.drop();
  await stop();
}, 30_000);

const database = () => {
  if (!db) throw new Error('database not ready');
  return db;
};

const serviceOver = (ledger: LedgerClient) => new TokenService(database().sql, ledger, new MemoryEventBus('svc-token'), options);

/** Runs `body` with the global fetch swapped for the harness fetch, over a service built on the real HTTP client. */
async function overHarness(fetchImpl: typeof fetch, body: (token: TokenService) => Promise<unknown>): Promise<void> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await body(serviceOver(createLedgerClient('http://ledger.test', SECRET)));
  } finally {
    globalThis.fetch = realFetch;
  }
}

const reset = () => database().truncateAll();

const fundUser = (ledger: MemoryLedger) =>
  ledger.post(recipes.deposit({ userId: USER, assetId: 'IFC', amount: amt('1000'), rail: 'test', railRef: 'saga-token-fund' }));

const openStake: MoneyDoorScenario = {
  name: 'svc-token open stake',
  secret: SECRET,
  verify: verifyServiceHeaders,
  async setup(ledger) {
    await reset();
    await fundUser(ledger);
  },
  run: (fetchImpl) => overHarness(fetchImpl, (token) => token.stake({ userId: USER, amount: amt('400'), tier: 'flex', stakeId: STAKE_ID })),
};

const closeStake: MoneyDoorScenario = {
  name: 'svc-token close stake',
  secret: SECRET,
  verify: verifyServiceHeaders,
  async setup(ledger) {
    await reset();
    await fundUser(ledger);
    await serviceOver(ledger).stake({ userId: USER, amount: amt('400'), tier: 'flex', stakeId: STAKE_ID });
  },
  run: (fetchImpl) =>
    overHarness(fetchImpl, async (token) => {
      try {
        await token.unstake(STAKE_ID);
      } catch (err) {
        if (!(err instanceof TokenError && err.code === 'token.stake_closed')) throw err;
      }
    }),
};

const mintEpoch: MoneyDoorScenario = {
  name: 'svc-token mint epoch',
  secret: SECRET,
  verify: verifyServiceHeaders,
  setup: reset,
  run: (fetchImpl) =>
    overHarness(fetchImpl, async (token) => {
      try {
        await token.mintEpoch(1);
      } catch (err) {
        if (!(err instanceof TokenError && err.code === 'token.epoch_closed')) throw err;
      }
    }),
};

describeMoneyDoor(openStake, () => new MemoryLedger());
describeMoneyDoor(closeStake, () => new MemoryLedger());
describeMoneyDoor(mintEpoch, () => new MemoryLedger());
