/**
 * The affiliate legs of a P2P release, in order, against Postgres: the seller confirms the fiat, `settle` posts
 * `escrowRelease` to the ledger, and only then is the fee accrued and paid out, each once, keyed by the trade. A
 * refund pays no affiliate. The HTTP clients the entrypoint hands the service are proved in `index-boot.test.ts`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testPostgres } from '@intafaced/db/test-postgres';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryEventBus } from '@intafaced/events';
import { MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AffiliateAccruePort, AffiliateP2pFeeLeg } from './affiliate-accrue.js';
import type { AffiliatePayoutPort } from './affiliate-payout.js';
import { InstrumentService } from './instrument-service.js';
import { ANY_COUNTRY } from './instruments.js';
import { P2pService } from './p2p-service.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SELLER = '11111111-1111-4111-8111-111111111111';
const BUYER = '22222222-2222-4222-8222-222222222222';
const TRADE_ID = '55555555-5555-4555-8555-555555555555';

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await testPostgres('postgres:16-alpine')
    .withDatabase('intafaced_affiliate_test')
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

describe('a P2P release pays the affiliate legs after the ledger post', () => {
  let order: string[];
  let accrued: AffiliateP2pFeeLeg[];
  let paid: string[];
  let p2p: P2pService;

  beforeEach(async () => {
    const sql = db!.sql;
    await db!.truncateAll();
    order = [];
    accrued = [];
    paid = [];
    const ledger = new MemoryLedger();
    const post = ledger.post.bind(ledger);
    ledger.post = async (recipe) => {
      order.push(`ledger:${recipe.idempotencyKey}`);
      return post(recipe);
    };
    const accrue: AffiliateAccruePort = {
      async accrueP2pFee(leg) {
        order.push(`accrue:${leg.feeEventId}`);
        accrued.push(leg);
      },
    };
    const payout: AffiliatePayoutPort = {
      async payoutP2pFee(feeEventId) {
        order.push(`payout:${feeEventId}`);
        paid.push(feeEventId);
      },
    };
    const instruments = new InstrumentService(sql);
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
    await ledger.post(recipes.deposit({ userId: SELLER, assetId: 'USDT', amount: amt('1000'), rail: 'test', railRef: 'affiliate-fund' }));
    p2p = new P2pService(sql, ledger, new MemoryEventBus('svc-p2p'), {
      instruments,
      feeBps: 100,
      referencePrices: { price: async () => null },
      affiliateAccrue: accrue,
      affiliatePayout: payout,
      deadlines: {
        escrowSeconds: 120,
        paymentSeconds: 900,
        releaseSeconds: 1800,
        disputeSeconds: 604_800,
        escalationRecheckSeconds: 3_600,
      },
    });
    const offer = await p2p.createOffer({
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
    await p2p.takeOffer({ offerId: offer.id, takerId: BUYER, amount: amt('100'), method: 'sepa', tradeId: TRADE_ID });
    order.length = 0;
  }, 60_000);

  it('posts escrowRelease, then accrues the fee, then pays it out, once each', async () => {
    await p2p.markFiatSent(TRADE_ID, BUYER);
    await p2p.confirmFiatReceived(TRADE_ID, SELLER);
    const feeEventId = `p2p.release:${TRADE_ID}`;
    expect(order).toEqual([`ledger:p2p.escrow.release:${TRADE_ID}`, `accrue:${feeEventId}`, `payout:${feeEventId}`]);
    expect(accrued).toEqual([{ userId: SELLER, feeAmount: amt('1'), feeAsset: 'USDT', feeEventId }]);
    expect(paid).toEqual([feeEventId]);
    // A settled trade is not settled again, so nothing is accrued or paid twice.
    await p2p.settle(TRADE_ID);
    expect(paid).toEqual([feeEventId]);
  });

  it('pays no affiliate leg when the escrow is refunded', async () => {
    await p2p.cancelTrade(TRADE_ID, BUYER);
    expect(order.some((step) => step.startsWith('ledger:'))).toBe(true);
    expect(accrued).toEqual([]);
    expect(paid).toEqual([]);
  });
});
