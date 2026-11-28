import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase } from '@intafaced/db';
import { MemoryLedger, recipes } from '@intafaced/ledger-client';
import { CommerceService } from './commerce/commerce-service.js';
import type { VendorEntitlement } from './stake-source.js';
import { MARKET_OPS_SCOPE, VendorService } from './vendor-service.js';
import type { AffiliateMarketFeeLeg } from './affiliate-accrue.js';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client';
import {
  AFFILIATE_PRODUCER_PAYOUT_PATH,
  createAffiliatePayoutClient,
  fireAffiliatePayout,
  NoopAffiliatePayout,
} from './affiliate-payout.js';

const VENDOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECRET = 'test-internal-service-secret-32ch!!';
const PURCHASE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FEE = `market.purchase:${PURCHASE}`;

const leg = {
  userId: VENDOR,
  feeAmount: parseAmount('1'),
  feeAsset: 'USDT',
  feeEventId: FEE,
};

describe('fireAffiliatePayout', () => {
  it('swallows a throw so the purchase stays posted', async () => {
    const port = {
      payoutMarketFee: async () => {
        throw new Error('identity down');
      },
    };
    await expect(fireAffiliatePayout(port, [leg])).resolves.toBeUndefined();
  });

  it('Noop never throws', async () => {
    await expect(fireAffiliatePayout(new NoopAffiliatePayout(), [leg])).resolves.toBeUndefined();
  });
});

describe('createAffiliatePayoutClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs { feeEventId } only — no amount, no rate', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const body = String(init.body);
      calls.push(body);
      expect(init.method).toBe('POST');
      expect(JSON.parse(body)).toEqual({ feeEventId: FEE });
      expect(Object.keys(JSON.parse(body))).toEqual(['feeEventId']);
      expect(String(url)).toBe(`http://identity.example${AFFILIATE_PRODUCER_PAYOUT_PATH}`);
      return new Response('{"posted":true}', { status: 200 });
    });
    const client = createAffiliatePayoutClient('http://identity.example', SECRET);
    await expect(client.payoutMarketFee(FEE)).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('412 is success (rates unset / unpublished / frozen / nothing accrued)', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"code":"affiliate.payout.rates_unset"}', { status: 412 }));
    const client = createAffiliatePayoutClient('http://identity.example', SECRET);
    await expect(client.payoutMarketFee(FEE)).resolves.toBeUndefined();
  });

  it('throws on 500 so fireAffiliatePayout can swallow without unwinding', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 500 }));
    const client = createAffiliatePayoutClient('http://identity.example', SECRET);
    await expect(client.payoutMarketFee(FEE)).rejects.toThrow(/500/);
  });
});

/**
 * A real pay-through purchase: Postgres (TEST_DATABASE_URL, a `*_test` admin URL) for the claim rows and the in-memory
 * ledger for the money, with the affiliate ports recording what the ledger held at the moment each was called.
 */
async function purchaseHarness() {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (!url) throw new Error('The purchase wiring test requires an isolated TEST_DATABASE_URL');
  const drizzle = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
  const migrations = readdirSync(drizzle)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort()
    .map((f) => readFileSync(join(drizzle, f), 'utf8'));
  const db = await createTestDatabase({ service: 'market', url, migrations });
  const vendors = new VendorService(db.sql, {
    async entitlementOf(): Promise<VendorEntitlement> {
      return { tierName: 'Operator', vendorSlots: 10 };
    },
  });
  const ledger = new MemoryLedger();
  const calls: string[] = [];
  const commerce = new CommerceService(db.sql, vendors, ledger, {
    commissionBps: 500,
    affiliateAccrue: {
      accrueMarketFee: async (leg: AffiliateMarketFeeLeg) => {
        const posted = await ledger.getTxByKey(leg.feeEventId);
        calls.push(`accrue ${leg.feeEventId} posted=${posted !== null}`);
      },
    },
    affiliatePayout: {
      payoutMarketFee: async (feeEventId: string) => {
        const posted = await ledger.getTxByKey(feeEventId);
        calls.push(`payout ${feeEventId} posted=${posted !== null}`);
      },
    },
  });
  const vendor = await vendors.applyAsVendor({ userId: SELLER_USER, displayName: 'TEST seller', description: 'TEST' });
  await vendors.vet({ vendorId: vendor.id, decision: 'approved', reason: 'TEST', actorId: OPERATOR_USER, actorScope: MARKET_OPS_SCOPE });
  await ledger.post(
    recipes.deposit({ userId: BUYER_USER, assetId: 'USDT', amount: parseAmount('100'), rail: 'test', railRef: randomUUID() }),
  );
  const listing = await commerce.createListing({
    userId: SELLER_USER,
    title: 'TEST one time',
    description: 'TEST listing',
    offerType: 'one_time',
    assetId: 'USDT',
    price: '10',
  });
  return { db, ledger, commerce, calls, listingId: listing.id };
}

const SELLER_USER = '11111111-1111-4111-8111-111111111111';
const BUYER_USER = '22222222-2222-4222-8222-222222222222';
const OPERATOR_USER = '33333333-3333-4333-8333-333333333333';

/** Purchase posts first, accrue second, payout third. */
describe('purchase wires payout after accrue after ledger post', () => {
  it('fires payout after accrue, after marketPurchase', async () => {
    const { db, commerce, calls, listingId } = await purchaseHarness();
    try {
      const purchaseId = randomUUID();
      const paid = await commerce.purchase({ buyerId: BUYER_USER, listingId, purchaseId });
      expect(paid).toMatchObject({ status: 'settled', flow: 'pay' });
      expect(calls).toEqual([`accrue market.purchase:${purchaseId} posted=true`, `payout market.purchase:${purchaseId} posted=true`]);
    } finally {
      await db.drop();
    }
  }, 120_000);
});
