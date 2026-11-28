import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase } from '@intafaced/db';
import { MemoryLedger, recipes } from '@intafaced/ledger-client';
import { CommerceService } from './commerce/commerce-service.js';
import type { VendorEntitlement } from './stake-source.js';
import { MARKET_OPS_SCOPE, VendorService } from './vendor-service.js';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { mulBps, parseAmount } from '@intafaced/ledger-client';
import {
  AFFILIATE_PRODUCER_PATH,
  affiliateLegAfterMarketPurchase,
  createAffiliateAccrueClient,
  fireAffiliateAccrue,
  NoopAffiliateAccrue,
  type AffiliateMarketFeeLeg,
} from './affiliate-accrue.js';

const VENDOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECRET = 'test-internal-service-secret-32ch!!';
const PURCHASE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('market affiliate accrue legs', () => {
  it('emits one fee-event keyed by purchase id; feeAmount floors like the recipe', () => {
    const snapshotPrice = parseAmount('10');
    const snapshotBps = 500;
    expect(
      affiliateLegAfterMarketPurchase({
        purchaseId: PURCHASE,
        vendorUserId: VENDOR,
        snapshotPrice,
        snapshotBps,
        feeAsset: 'USDT',
      }),
    ).toEqual([
      {
        userId: VENDOR,
        feeAmount: mulBps(snapshotPrice, snapshotBps, 'floor'),
        feeAsset: 'USDT',
        feeEventId: `market.purchase:${PURCHASE}`,
      },
    ]);
  });

  it('skips zero fees', () => {
    expect(
      affiliateLegAfterMarketPurchase({
        purchaseId: PURCHASE,
        vendorUserId: VENDOR,
        snapshotPrice: parseAmount('10'),
        snapshotBps: 0,
        feeAsset: 'USDT',
      }),
    ).toEqual([]);
  });
});

describe('fireAffiliateAccrue', () => {
  it('swallows a throw so the purchase stays posted', async () => {
    const port = {
      accrueMarketFee: async () => {
        throw new Error('identity down');
      },
    };
    await expect(
      fireAffiliateAccrue(port, [
        {
          userId: VENDOR,
          feeAmount: parseAmount('1'),
          feeAsset: 'USDT',
          feeEventId: `market.purchase:${PURCHASE}`,
        },
      ]),
    ).resolves.toBeUndefined();
  });

  it('Noop never throws', async () => {
    await expect(fireAffiliateAccrue(new NoopAffiliateAccrue(), [])).resolves.toBeUndefined();
  });
});

describe('createAffiliateAccrueClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs v2-bound JSON with sourceModule market; 412 is success', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const body = String(init.body);
      calls.push(body);
      expect(init.method).toBe('POST');
      expect(JSON.parse(body)).toEqual({
        feeEventId: `market.purchase:${PURCHASE}`,
        userId: VENDOR,
        feeAmount: '1',
        asset: 'USDT',
        sourceModule: 'market',
      });
      expect(String(url)).toBe(`http://identity.example${AFFILIATE_PRODUCER_PATH}`);
      return new Response('{"code":"affiliate.accrual.rates_unset"}', { status: 412 });
    });
    const client = createAffiliateAccrueClient('http://identity.example', SECRET);
    await expect(
      client.accrueMarketFee({
        userId: VENDOR,
        feeAmount: parseAmount('1'),
        feeAsset: 'USDT',
        feeEventId: `market.purchase:${PURCHASE}`,
      }),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('throws on 500 so fireAffiliateAccrue can swallow without unwinding', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 500 }));
    const client = createAffiliateAccrueClient('http://identity.example', SECRET);
    await expect(
      client.accrueMarketFee({
        userId: VENDOR,
        feeAmount: parseAmount('1'),
        feeAsset: 'USDT',
        feeEventId: `market.purchase:${PURCHASE}`,
      } satisfies AffiliateMarketFeeLeg),
    ).rejects.toThrow(/500/);
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

describe('purchase wires accrue after ledger post', () => {
  it('fires accrue after marketPurchase, not before', async () => {
    const { db, commerce, calls, listingId } = await purchaseHarness();
    try {
      const purchaseId = randomUUID();
      const paid = await commerce.purchase({ buyerId: BUYER_USER, listingId, purchaseId });
      expect(paid).toMatchObject({ status: 'settled', flow: 'pay' });
      const accrued = calls.filter((c) => c.startsWith('accrue'));
      expect(accrued).toEqual([`accrue market.purchase:${purchaseId} posted=true`]);
    } finally {
      await db.drop();
    }
  }, 120_000);
});
