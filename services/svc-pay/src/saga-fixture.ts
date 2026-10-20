/**
 * TEST SUPPORT for the SAGATEST money-door replays in `saga.*.money.test.ts`. Production never imports this file.
 *
 * Opens a per-run Postgres database with every pay migration, and builds a `PayService` over an in-memory rail set.
 * The harness decides which ledger the service talks to: `setup` is handed the harness `MemoryLedger`, and `run` swaps
 * `globalThis.fetch` for the harness door and rebuilds the service over the real `createLedgerClient`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import type { LedgerClient } from '@intafaced/ledger-client';
import { PayService } from './payment-service.js';
import { truncatePayForTest } from './payment-events-test-reset.js';
import { memoryPayoutDestinations } from './merchant-payout-destination.js';
import { RailRegistry } from './rails/registry.js';
import { CardSandboxAdapter } from './rails/card-sandbox.js';
import { CryptoNativeAdapter } from './rails/crypto-native.js';
import { BankPayoutAbsentAdapter } from './rails/bank-payout.js';
import { MemoryChain } from './rails/chain-port.js';
import { REFERENCE_RAIL_ROUTING_PROFILES } from './routing/decide.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

export const SAGA_SECRET = 'svc-pay-saga-internal-secret-at-least-32';

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

export interface SagaPayDatabase {
  database(): TestDatabase;
  open(): Promise<void>;
  close(): Promise<void>;
}

export function sagaPayDatabase(): SagaPayDatabase {
  let db: TestDatabase | undefined;
  let stop: () => Promise<void> = async () => undefined;
  return {
    database() {
      if (!db) throw new Error('database not ready');
      return db;
    },
    async open() {
      const admin = await openAdmin();
      stop = admin.stop;
      db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    },
    async close() {
      await db?.drop();
      await stop();
    },
  };
}

export async function resetPay(db: TestDatabase): Promise<void> {
  await truncatePayForTest(
    db.sql,
    'pay',
    `TRUNCATE pay.checkout_sessions, pay.payment_links, pay.settlements, pay.payment_events, pay.payments, pay.payment_profiles, pay.merchants, pay.withdrawals, pay.deposits RESTART IDENTITY CASCADE`,
  );
}

export const SAGA_MERCHANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const SAGA_SETTLEMENT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const SAGA_WITHDRAWAL_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

/**
 * The harness compares ledger keys between fresh runs, so the ids the database mints must repeat. Each scenario makes
 * one merchant, at most one settlement and at most one withdrawal, so a constant column default is enough (the tables are emptied first).
 * This changes the test database only, never a migration.
 */
export async function pinPayIds(db: TestDatabase): Promise<void> {
  await db.sql.unsafe(`ALTER TABLE pay.merchants ALTER COLUMN id SET DEFAULT '${SAGA_MERCHANT_ID}'::uuid`);
  await db.sql.unsafe(`ALTER TABLE pay.settlements ALTER COLUMN id SET DEFAULT '${SAGA_SETTLEMENT_ID}'::uuid`);
  await db.sql.unsafe(`ALTER TABLE pay.withdrawals ALTER COLUMN id SET DEFAULT '${SAGA_WITHDRAWAL_ID}'::uuid`);
}

/** Rails that outlive one run, so a crash and a retry see the same chain. */
export function sagaRails() {
  const chain = new MemoryChain();
  const crypto = new CryptoNativeAdapter({ chain, secret: SAGA_SECRET, minConfirmations: 6, toleranceSeconds: 300 });
  const card = new CardSandboxAdapter({ secret: SAGA_SECRET, toleranceSeconds: 300 });
  return { chain, crypto, card, registry: new RailRegistry([card, crypto, new BankPayoutAbsentAdapter()]) };
}

export function payServiceOver(db: TestDatabase, ledger: LedgerClient, rails: RailRegistry): PayService {
  return new PayService(db.sql, ledger, rails, {
    payoutDestinations: memoryPayoutDestinations(),
    checkoutRiskBand: 'low',
    routingProfiles: REFERENCE_RAIL_ROUTING_PROFILES.map((p) =>
      p.railId === 'crypto-native' ? { ...p, successRate: '0.90' } : p.railId === 'card-sandbox' ? { ...p, successRate: '0.88' } : { ...p },
    ),
    linkDefaultTtlDays: 30,
    linkMaxTtlDays: 365,
    checkoutSessionTtlSeconds: 900,
    maxOpenSessionsPerLink: 25,
  });
}

/** Runs `body` with every `fetch` going through the harness door. */
export async function overHarness<T>(fetchImpl: typeof fetch, body: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await body();
  } finally {
    globalThis.fetch = realFetch;
  }
}
