/**
 * SAGATEST for svc-bank's business transfer: the held proposal (hold post) followed by its approval (settle post).
 * `describeMoneyDoor` replays it as a duplicate request, a lost acknowledgement on each post, and a crash after each
 * post, and requires the book of one clean run every time. The bank database survives a crash, as it would for real.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { verifyServiceHeaders } from '@intafaced/contracts';
import { MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { describeMoneyDoor, type MoneyDoorScenario } from '@intafaced/ledger-client/testing/saga';
import { createBankServices, memoryRecipientState } from './bank-service.js';
import { memoryLedgerHistory } from './analytics/ledger-history.js';
import { createLedgerClient } from './ledger-client.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SECRET = 'svc-bank-test-internal-secret-0123456789';
const MAKER = '11111111-1111-4111-8111-111111111111';
const CHECKER = '22222222-2222-4222-8222-222222222222';
const CLIENT_ID = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';

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
  db = await createTestDatabase({ service: 'bank', url: admin.url, migrations });
}, 120_000);

afterAll(async () => {
  await db?.drop();
  await stop();
}, 30_000);

const sql = () => {
  if (!db) throw new Error('database not ready');
  return db.sql;
};

/** The ids of the spaces the setup made; the door acts on these. */
const spaces: { from?: string; to?: string } = {};

const heldTransfer: MoneyDoorScenario = {
  name: 'svc-bank business transfer (hold, then settle)',
  secret: SECRET,
  verify: verifyServiceHeaders,
  async setup(ledger) {
    await sql()`
      TRUNCATE bank.business_payroll_lines, bank.business_payroll_runs,
               bank.business_approvals, bank.business_members, bank.business_accounts,
               bank.transfer_executions, bank.scheduled_transfers, bank.spaces
      RESTART IDENTITY CASCADE
    `;
    await ledger.post(recipes.deposit({ userId: MAKER, assetId: 'USDT', amount: amt('1000'), rail: 'test', railRef: 'saga-bank-fund' }));
    const direct = createBankServices(sql(), ledger, memoryLedgerHistory(ledger), {
      nativeAssetId: 'IFC',
      recipients: memoryRecipientState(),
    });
    const account = await direct.business.createAccount({
      accountId: ACCOUNT_ID,
      name: 'Ops Co',
      assetId: 'USDT',
      spendThreshold: amt('50'),
      creatorUserId: MAKER,
    });
    await direct.business.addMember({ accountId: account.id, actorUserId: MAKER, userId: CHECKER, role: 'checker' });
    spaces.from = (await direct.spaces.ensurePrimary(MAKER, 'USDT')).id;
    spaces.to = (await direct.spaces.create({ userId: MAKER, assetId: 'USDT', name: 'Vendor' })).id;
  },
  async run(fetchImpl) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const ledger = new MemoryLedger();
      const bank = createBankServices(sql(), createLedgerClient('http://ledger.test', SECRET), memoryLedgerHistory(ledger), {
        nativeAssetId: 'IFC',
        recipients: memoryRecipientState(),
      });
      await bank.business.proposeTransfer({
        clientId: CLIENT_ID,
        accountId: ACCOUNT_ID,
        makerUserId: MAKER,
        fromSpaceId: spaces.from!,
        toSpaceId: spaces.to!,
        amount: amt('100'),
      });
      await bank.business.approve({ approvalId: CLIENT_ID, checkerUserId: CHECKER });
    } finally {
      globalThis.fetch = realFetch;
    }
  },
};

describeMoneyDoor(heldTransfer, () => new MemoryLedger());
