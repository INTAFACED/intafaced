import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createMarketRouter } from '../router.js';
import { userCopy } from '../user-copy.js';
import { MarketError } from '../vendor-service.js';
import { CommerceService } from './commerce-service.js';
import { marketListingCategoriesSchema, readListingCategories } from './listing-categories.js';

/**
 * RC-more-catalogue-18 — category taxonomy for non-strategy listings.
 * The Operation Zero spec is not in this repo. The owner publishes slugs.
 * This file must not grow a built-in category list or a price.
 */

const TAXONOMY = ['signals', 'data-feeds'] as const;
const USER = '11111111-1111-4111-8111-111111111111';
const VENDOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LISTING = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

const SECRET = 'listing-category-edge-secret-long-enough';
const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-market' });

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['market:read', 'market:write'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  } as Principal;
}

const anonymous = () => edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-anon' });

function signed(p: Principal = principal()) {
  const raw = encodePrincipal(p);
  return edgeContext({
    headers: {
      'x-intafaced-principal': raw,
      'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
      'x-intafaced-region': 'DE',
    },
    id: 'req-signed',
  });
}

function refusingSql() {
  return vi.fn(() => {
    throw new Error('sql must not run');
  });
}

function service(opts?: { commissionBps?: number | null; listingCategories?: readonly string[] | null; sql?: unknown; vendors?: unknown }) {
  return new CommerceService(
    (opts?.sql ?? refusingSql()) as never,
    (opts?.vendors ?? { myVendor: vi.fn(), claimSlot: vi.fn() }) as never,
    {
      post: vi.fn(),
    } as never,
    {
      commissionBps: opts?.commissionBps === undefined ? 500 : opts.commissionBps,
      listingCategories: opts && 'listingCategories' in opts ? opts.listingCategories : TAXONOMY,
    },
  );
}

const baseCreate = {
  userId: USER,
  title: 'Tape',
  description: 'A tape of prints',
  assetId: 'USDT',
  price: '10',
  category: 'signals',
};

describe('listing category taxonomy — no built-in list', () => {
  it('treats missing and blank env as unset', () => {
    for (const raw of [undefined, null, '', ' ', '\n\t']) {
      expect(readListingCategories(raw)).toBeUndefined();
      expect(marketListingCategoriesSchema.parse(raw)).toBeUndefined();
    }
  });

  it('parses a published comma list and keeps order', () => {
    expect(readListingCategories(' signals , data-feeds ')).toEqual(['signals', 'data-feeds']);
    expect(marketListingCategoriesSchema.parse('signals,data-feeds')).toEqual(['signals', 'data-feeds']);
  });

  it('refuses a hole, a duplicate, or a slug the owner did not write in lowercase', () => {
    for (const raw of ['signals,,data-feeds', 'signals,signals', 'Signals', 'signals,has space', 'a'.repeat(33)]) {
      expect(() => readListingCategories(raw)).toThrow(/MARKET_LISTING_CATEGORIES/);
      expect(() => marketListingCategoriesSchema.parse(raw)).toThrow(/MARKET_LISTING_CATEGORIES/);
    }
  });

  it('does not seed categories in the migration', () => {
    const sql = readFileSync(join(ROOT, 'drizzle/0010_market_listing_category.sql'), 'utf8');
    expect(sql).not.toMatch(/INSERT/i);
    expect(sql).toContain('"category"');
    const down = readFileSync(join(ROOT, 'drizzle/0010_market_listing_category.down.sql'), 'utf8');
    expect(down).toContain('DROP COLUMN IF EXISTS "category"');
  });

  it('echoes the refuse code and does not invent category copy', () => {
    for (const code of ['market.category_taxonomy_unset', 'market.listing_category_unset', 'market.listing_category_unknown']) {
      expect(userCopy(code)).toBe(code);
      expect(userCopy(code)).not.toMatch(/ /);
    }
  });
});

describe('non-strategy listings refuse blank category, price, and limit', () => {
  it('refuses an unpublished taxonomy before sql', async () => {
    const sql = refusingSql();
    const svc = service({ listingCategories: null, sql });
    expect(() => svc.listingCategories()).toThrow(MarketError);
    expect(() => svc.listingCategories()).toThrow(expect.objectContaining({ code: 'market.category_taxonomy_unset' }));
    await expect(svc.publicListingsByCategory({ category: 'signals', limit: 10 })).rejects.toMatchObject({
      code: 'market.category_taxonomy_unset',
    });
    await expect(svc.createNonStrategyListing(baseCreate)).rejects.toBeInstanceOf(MarketError);
    await expect(svc.createNonStrategyListing(baseCreate)).rejects.toMatchObject({ code: 'market.category_taxonomy_unset' });
    expect(sql).not.toHaveBeenCalled();
  });

  it('refuses a blank category and an unknown slug — blank is not every listing', async () => {
    const sql = refusingSql();
    const svc = service({ sql });
    await expect(svc.publicListingsByCategory({ limit: 10 })).rejects.toMatchObject({ code: 'market.listing_category_unset' });
    await expect(svc.publicListingsByCategory({ category: '  ', limit: 10 })).rejects.toMatchObject({
      code: 'market.listing_category_unset',
    });
    await expect(svc.createNonStrategyListing({ ...baseCreate, category: '' })).rejects.toMatchObject({
      code: 'market.listing_category_unset',
    });
    await expect(svc.createNonStrategyListing({ ...baseCreate, category: 'bots' })).rejects.toMatchObject({
      code: 'market.listing_category_unknown',
    });
    await expect(svc.publicListingsByCategory({ category: 'bots', limit: 10 })).rejects.toMatchObject({
      code: 'market.listing_category_unknown',
    });
    expect(sql).not.toHaveBeenCalled();
  });

  it('refuses a blank limit before inventing 50, and a blank price before inventing 0', async () => {
    const sql = refusingSql();
    const svc = service({ sql, commissionBps: null });
    await expect(svc.publicListingsByCategory({ category: 'signals' })).rejects.toMatchObject({
      code: 'market.public_listings_list_limit_unset',
    });
    await expect(svc.createNonStrategyListing({ ...baseCreate, price: '  ' })).rejects.toMatchObject({
      code: 'market.listing_invalid_price',
    });
    await expect(svc.createNonStrategyListing({ ...baseCreate, price: undefined })).rejects.toMatchObject({
      code: 'market.listing_invalid_price',
    });
    expect(sql).not.toHaveBeenCalled();
  });

  it('returns no rows when commission is unset, after the category is real', async () => {
    const sql = refusingSql();
    const svc = service({ sql, commissionBps: null });
    await expect(svc.publicListingsByCategory({ category: 'signals', limit: 10 })).resolves.toEqual([]);
    expect(sql).not.toHaveBeenCalled();
  });

  it('returns the published list and does not keep a caller mutation', () => {
    const svc = service();
    const list = svc.listingCategories();
    expect(list).toEqual(['signals', 'data-feeds']);
    (list as string[]).push('bots');
    expect(svc.listingCategories()).toEqual(['signals', 'data-feeds']);
  });

  it('writes one-time with the trimmed slug and does not file it as a strategy', async () => {
    const values: unknown[][] = [];
    const row = {
      id: LISTING,
      vendor_id: VENDOR,
      title: 'Tape',
      description: 'A tape of prints',
      offer_type: 'one_time' as const,
      asset_id: 'USDT',
      price: '10',
      period_seconds: null,
      category: 'signals',
      status: 'active' as const,
      created_at: new Date('2026-10-23T00:00:00.000Z'),
      updated_at: new Date('2026-10-23T00:00:00.000Z'),
    };
    const sql = vi.fn(async (_strings: TemplateStringsArray, ...bound: unknown[]) => {
      values.push(bound);
      return [row];
    });
    const vendors = {
      myVendor: vi.fn(async () => ({ id: VENDOR, status: 'approved' as const })),
      claimSlot: vi.fn(async () => ({ claimed: true })),
    };
    const svc = service({ sql, vendors });
    const created = await svc.createNonStrategyListing({ ...baseCreate, category: ' signals ' });
    expect(created).toMatchObject({ id: LISTING, offerType: 'one_time', category: 'signals', price: '10', periodSeconds: null });
    expect(values[0]).toContain('one_time');
    expect(values[0]).toContain('signals');
    expect(values[0]).not.toContain('subscription');
    expect(vendors.claimSlot).toHaveBeenCalledWith({ userId: USER, ref: LISTING });
  });

  it('leaves strategy create uncategorised', async () => {
    const values: unknown[][] = [];
    const row = {
      id: LISTING,
      vendor_id: VENDOR,
      title: 'Mean',
      description: 'A listed strategy',
      offer_type: 'subscription' as const,
      asset_id: 'USDT',
      price: '12.5',
      period_seconds: 86400,
      category: null,
      status: 'active' as const,
      created_at: new Date('2026-10-23T00:00:00.000Z'),
      updated_at: new Date('2026-10-23T00:00:00.000Z'),
    };
    const sql = vi.fn(async (_strings: TemplateStringsArray, ...bound: unknown[]) => {
      values.push(bound);
      return [row];
    });
    const svc = service({
      sql,
      vendors: {
        myVendor: vi.fn(async () => ({ id: VENDOR, status: 'approved' as const })),
        claimSlot: vi.fn(async () => ({ claimed: true })),
      },
    });
    const created = await svc.createListing({
      userId: USER,
      title: 'Mean',
      description: 'A listed strategy',
      offerType: 'subscription',
      assetId: 'USDT',
      price: '12.50',
      periodSeconds: 86_400,
    });
    expect(created.offerType).toBe('subscription');
    expect(values[0]?.at(-1)).toBeNull();
    expect(values[0]).toContain('subscription');
    expect(values[0]).not.toContain('signals');
  });

  it('queries only active one-time rows in that category and keeps a live slot', async () => {
    const bound: unknown[][] = [];
    let calls = 0;
    const row = {
      id: LISTING,
      vendor_id: VENDOR,
      title: 'Tape',
      description: 'A tape of prints',
      offer_type: 'one_time' as const,
      asset_id: 'USDT',
      price: '10',
      period_seconds: null,
      category: 'data-feeds',
      status: 'active' as const,
      created_at: new Date('2026-10-23T00:00:00.000Z'),
      updated_at: new Date('2026-10-23T00:00:00.000Z'),
    };
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls += 1;
      bound.push(values);
      if (calls === 1) {
        expect(strings.join(' ')).toContain("offer_type = 'one_time'");
        expect(strings.join(' ')).toContain('category =');
        return [row];
      }
      return [{ id: 'slot' }];
    });
    const svc = service({
      sql,
      vendors: {
        listingEligibility: vi.fn(async () => ({ listed: true })),
        entitledListingRefs: vi.fn(async () => new Set([LISTING])),
      },
    });
    const page = await svc.publicListingsByCategory({ category: 'data-feeds', limit: 10 });
    expect(page).toEqual([expect.objectContaining({ id: LISTING, category: 'data-feeds', offerType: 'one_time' })]);
    expect(bound[0]).toContain('data-feeds');
    expect(bound[0]).toContain(30);
  });
});

describe('category doors on the market router', () => {
  const listed = {
    id: LISTING,
    vendorId: VENDOR,
    title: 'Tape',
    description: 'A tape of prints',
    offerType: 'one_time' as const,
    assetId: 'USDT',
    price: '10',
    periodSeconds: null,
    status: 'active' as const,
    createdAt: '2026-10-23T00:00:00.000Z',
    updatedAt: '2026-10-23T00:00:00.000Z',
    category: 'signals',
  };

  it('serves listingCategories to an anonymous caller', async () => {
    const commerce = { listingCategories: vi.fn(() => ['signals', 'data-feeds']) };
    const reply = await createMarketRouter({} as never, commerce as never)
      .createCaller(anonymous())
      .listingCategories();
    expect(reply).toEqual({ categories: ['signals', 'data-feeds'] });
  });

  it('maps an unpublished taxonomy and a blank category to precondition failures', async () => {
    const commerce = {
      listingCategories: vi.fn(() => {
        throw new MarketError('market.category_taxonomy_unset', 'market.category_taxonomy_unset');
      }),
      publicListingsByCategory: vi.fn(() => {
        throw new MarketError('market.listing_category_unset', 'market.listing_category_unset');
      }),
    };
    await expect(
      createMarketRouter({} as never, commerce as never)
        .createCaller(anonymous())
        .listingCategories(),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'market.category_taxonomy_unset' });
    await expect(
      createMarketRouter({} as never, commerce as never)
        .createCaller(anonymous())
        .listingsByCategory({ limit: 10 }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'market.listing_category_unset' });
  });

  it('maps an unknown category to a bad request and passes limit through', async () => {
    const commerce = {
      publicListingsByCategory: vi.fn(async () => {
        throw new MarketError('market.listing_category_unknown', 'market.listing_category_unknown');
      }),
    };
    await expect(
      createMarketRouter({} as never, commerce as never)
        .createCaller(anonymous())
        .listingsByCategory({ category: 'bots', limit: 10 }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'market.listing_category_unknown' });
    expect(commerce.publicListingsByCategory).toHaveBeenCalledWith({ category: 'bots', limit: 10 });
  });

  it('refuses createNonStrategyListing without market:write and never calls commerce', async () => {
    const commerce = { createNonStrategyListing: vi.fn(async () => listed) };
    const reader = principal({ scopes: ['market:read'] });
    await expect(
      createMarketRouter({} as never, commerce as never)
        .createCaller(signed(reader))
        .createNonStrategyListing({ title: 'Tape', description: 'A tape of prints', assetId: 'USDT', price: '10', category: 'signals' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(commerce.createNonStrategyListing).not.toHaveBeenCalled();
  });

  it('creates a non-strategy listing for the signed vendor', async () => {
    const commerce = { createNonStrategyListing: vi.fn(async () => listed) };
    const reply = await createMarketRouter({} as never, commerce as never)
      .createCaller(signed())
      .createNonStrategyListing({ title: 'Tape', description: 'A tape of prints', assetId: 'USDT', price: '10', category: 'signals' });
    expect(reply).toEqual(listed);
    expect(commerce.createNonStrategyListing).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER, category: 'signals', price: '10' }),
    );
  });

  it('rejects a strategy period on the non-strategy door', async () => {
    const commerce = { createNonStrategyListing: vi.fn() };
    await expect(
      createMarketRouter({} as never, commerce as never)
        .createCaller(signed())
        .createNonStrategyListing({
          title: 'Tape',
          description: 'A tape of prints',
          assetId: 'USDT',
          price: '10',
          category: 'signals',
          periodSeconds: 86_400,
        } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(commerce.createNonStrategyListing).not.toHaveBeenCalled();
  });
});
