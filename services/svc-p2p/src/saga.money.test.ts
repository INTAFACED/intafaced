/**
 * SAGATEST for svc-p2p's escrow release: the seller confirms the fiat, the trade records its decision, and `settle`
 * posts `escrowRelease`. `describeMoneyDoor` replays that as a duplicate request, a lost acknowledgement, and a crash
 * after the post, and requires the book of one clean run every time.
 *
 * The door drives the trade the way a retry does: confirm while the fiat is only marked sent, otherwise finish a
 * recorded decision with `settle` (the sweep's call). A trade already settled is left alone.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { verifyServiceHeaders } from '@intafaced/contracts';
import { MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { describeMoneyDoor, type MoneyDoorScenario } from '@intafaced/ledger-client/testing/saga';
import { P2pService } from './p2p-service.js';
import { InstrumentService } from './instrument-service.js';
import { ANY_COUNTRY } from './instruments.js';
import { createLedgerClient } from './ledger-client.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SECRET = 'svc-p2p-test-internal-secret-0123456789';
const SELLER = '11111111-1111-4111-8111-111111111111';
const BUYER = '22222222-2222-4222-8222-222222222222';
const TRADE_ID = '55555555-5555-4555-8555-555555555555';

const deadlines = {
  escrowSeconds: 120,
  paymentSeconds: 900,
  releaseSeconds: 1800,
  disputeSeconds: 604_800,
  escalationRecheckSeconds: 3_600,
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
  db = await createTestDatabase({ service: 'p2p', url: admin.url, migrations });
}, 120_000);

afterAll(async () => {
  await db?.drop();
  await stop();
}, 30_000);

const database = () => {
  if (!db) throw new Error('database not ready');
  return db;
};

const serviceOver = (ledger: ConstructorParameters<typeof P2pService>[1]) =>
  new P2pService(database().sql, ledger, new MemoryEventBus('svc-p2p'), {
    instruments: new InstrumentService(database().sql),
    feeBps: 100,
    referencePrices: { price: async () => null },
    deadlines,
  });

const releaseEscrow: MoneyDoorScenario = {
  name: 'svc-p2p escrow release (confirm, then settle)',
  secret: SECRET,
  verify: verifyServiceHeaders,
  async setup(ledger) {
    await database().truncateAll();
    const instruments = new InstrumentService(database().sql);
    await instruments.registerMethodSchema({
      methodId: 'sepa',
      country: ANY_COUNTRY,
      label: 'Bank transfer (test fixture)',
      fields: [{ key: 'account_reference', label: 'Account reference', required: true }],
    });
    await instruments.createInstrument({
      ownerId: SELLER,
      methodId: 'sepa',
      country: 'DE',
      fiatCurrency: 'USD',
      label: 'USD destination',
      details: { account_reference: `ref-${SELLER}` },
      instrumentId: '66666666-6666-4666-8666-666666666666',
    });
    await ledger.post(recipes.deposit({ userId: SELLER, assetId: 'USDT', amount: amt('1000'), rail: 'test', railRef: 'saga-p2p-fund' }));
    const direct = serviceOver(ledger);
    const offer = await direct.createOffer({
      makerId: SELLER,
      side: 'sell',
      asset: 'USDT',
      fiatCurrency: 'USD',
      priceType: 'fixed',
      price: amt('1'),
      minAmt: amt('10'),
      maxAmt: amt('500'),
      totalAmt: amt('500'),
      methods: ['sepa'],
    });
    await direct.takeOffer({ offerId: offer.id, takerId: BUYER, amount: amt('100'), method: 'sepa', tradeId: TRADE_ID });
    await direct.markFiatSent(TRADE_ID, BUYER);
  },
  async run(fetchImpl) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const p2p = serviceOver(createLedgerClient('http://ledger.test', SECRET));
      const trade = await p2p.getTrade(TRADE_ID);
      if (trade.settledAt) return;
      if (trade.status === 'fiat_sent') await p2p.confirmFiatReceived(TRADE_ID, SELLER);
      else await p2p.settle(TRADE_ID);
    } finally {
      globalThis.fetch = realFetch;
    }
  },
};

describeMoneyDoor(releaseEscrow, () => new MemoryLedger());
