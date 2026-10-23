import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, MARKET_LISTING_CATEGORIES, signPrincipalHeader } from '@intafaced/contracts';
import { createMarketRouter } from '../router.js';
import { userCopy } from '../user-copy.js';
import { MarketError } from '../vendor-service.js';
import { CommerceService } from './commerce-service.js';

/**
 * RC-more-catalogue-18 — product categories for one-time listings.
 * The enum lives in packages/contracts. One-time create may omit it.
 * Strategy listings stay uncategorised. The category page has no cursor yet.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const OP = '33333333-3333-4333-8333-333333333333';
const VENDOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LISTING = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const REPO = join(ROOT, '..', '..');

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

function service(opts?: { commissionBps?: number | null; sql?: unknown; vendors?: unknown }) {
  return new CommerceService(
    (opts?.sql ?? refusingSql()) as never,
    (opts?.vendors ?? { myVendor: vi.fn(), claimSlot: vi.fn() }) as never,
    {
      post: vi.fn(),
    } as never,
    {
      commissionBps: opts?.commissionBps === undefined ? 500 : opts.commissionBps,
    },
  );
}

const baseCreate = {
  userId: USER,
  title: 'Tape',
  description: 'A tape of prints',
  assetId: 'USDT',
  price: '10',
  category: 'bots',
};

const rowAt = {
  created_at: new Date('2026-10-23T00:00:00.000Z'),
  updated_at: new Date('2026-10-23T00:00:00.000Z'),
};

describe('listing category enum — not an owner env list', () => {
  it('serves the product enum and does not keep a caller mutation', () => {
    const svc = service();
    const list = svc.listingCategories();
    expect(list).toEqual([...MARKET_LISTING_CATEGORIES]);
    (list as string[]).push('signals');
    expect(svc.listingCategories()).toEqual([...MARKET_LISTING_CATEGORIES]);
  });

  it('drops the owner env wiring', () => {
    const compose = readFileSync(join(REPO, 'docker-compose.apps.yml'), 'utf8');
    const envExample = readFileSync(join(REPO, '.env.example'), 'utf8');
    const envTs = readFileSync(join(ROOT, 'src/env.ts'), 'utf8');
    expect(compose).not.toContain('MARKET_LISTING_CATEGORIES');
    expect(envExample).not.toContain('MARKET_LISTING_CATEGORIES');
    expect(envTs).not.toContain('MARKET_LISTING_CATEGORIES');
    expect(envTs).not.toContain('category_taxonomy_unset');
  });

  it('stores the enum in the migration and does not seed rows', () => {
    const sql = readFileSync(join(ROOT, 'drizzle/0010_market_listing_category.sql'), 'utf8');
    const tightened = readFileSync(join(ROOT, 'drizzle/0011_market_listing_category_event.sql'), 'utf8');
    expect(sql).not.toMatch(/INSERT/i);
    expect(tightened).not.toMatch(/INSERT INTO/i);
    for (const slug of MARKET_LISTING_CATEGORIES) {
      expect(sql).toContain(`'${slug}'`);
      expect(tightened).toContain(`'${slug}'`);
    }
    expect(tightened).toContain('listing_category_events');
    expect(tightened).toContain('business_key');
    expect(tightened).toContain('actor_id');
    expect(tightened).toContain('append-only');
    const down = readFileSync(join(ROOT, 'drizzle/0010_market_listing_category.down.sql'), 'utf8');
    expect(down).toContain('DROP COLUMN IF EXISTS "category"');
    const eventDown = readFileSync(join(ROOT, 'drizzle/0011_market_listing_category_event.down.sql'), 'utf8');
    expect(eventDown).toContain('DROP TABLE IF EXISTS "market"."listing_category_events"');
  });

  it('echoes the refuse code and does not invent category copy', () => {
    for (const code of ['market.category_invalid', 'market.listing_category_unset', 'market.category_reason_short']) {
      expect(userCopy(code)).toBe(code);
      expect(userCopy(code)).not.toMatch(/ /);
    }
    expect(userCopy('market.category_taxonomy_unset')).toBe('market.category_taxonomy_unset');
  });
});

describe('one-time category is optional; a given slug must be the enum', () => {
  it('refuses a blank category page and an unknown slug before sql', async () => {
    const sql = refusingSql();
    const svc = service({ sql });
    await expect(svc.publicListingsByCategory({ limit: 10 })).rejects.toMatchObject({ code: 'market.listing_category_unset' });
    await expect(svc.publicListingsByCategory({ category: '  ', limit: 10 })).rejects.toMatchObject({
      code: 'market.listing_category_unset',
    });
    await expect(svc.createNonStrategyListing({ ...baseCreate, category: '' })).rejects.toMatchObject({
      code: 'market.listing_category_unset',
    });
    await expect(svc.createNonStrategyListing({ ...baseCreate, category: 'signals' })).rejects.toMatchObject({
      code: 'market.category_invalid',
    });
    await expect(svc.publicListingsByCategory({ category: 'signals', limit: 10 })).rejects.toMatchObject({
      code: 'market.category_invalid',
    });
    expect(sql).not.toHaveBeenCalled();
  });

  it('refuses a blank limit before inventing 50, and a blank price before inventing 0', async () => {
    const sql = refusingSql();
    const svc = service({ sql, commissionBps: null });
    await expect(svc.publicListingsByCategory({ category: 'bots' })).rejects.toMatchObject({
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
    await expect(svc.publicListingsByCategory({ category: 'bots', limit: 10 })).resolves.toEqual([]);
    expect(sql).not.toHaveBeenCalled();
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
      category: 'bots',
      status: 'active' as const,
      ...rowAt,
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
    const created = await svc.createNonStrategyListing({ ...baseCreate, category: ' bots ' });
    expect(created).toMatchObject({ id: LISTING, offerType: 'one_time', category: 'bots', price: '10', periodSeconds: null });
    expect(values[0]).toContain('one_time');
    expect(values[0]).toContain('bots');
    expect(values[0]).not.toContain('subscription');
    expect(vendors.claimSlot).toHaveBeenCalledWith({ userId: USER, ref: LISTING });
  });

  it('keeps one-time createListing uncategorised when no category is given', async () => {
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
      category: null,
      status: 'active' as const,
      ...rowAt,
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
    const input = {
      userId: USER,
      title: 'Tape',
      description: 'A tape of prints',
      offerType: 'one_time' as const,
      assetId: 'USDT',
      price: '10',
    };
    await svc.createListing(input);
    await svc.createListing({ ...input, category: null });
    await svc.createListing({ ...input, category: '  ' });
    expect(values).toHaveLength(3);
    for (const bound of values) expect(bound.at(-1)).toBeNull();
    await expect(svc.createListing({ ...input, category: 'signals' })).rejects.toMatchObject({ code: 'market.category_invalid' });
    expect(vendors.claimSlot).toHaveBeenCalledTimes(3);
  });

  it('stores the product slug from one-time createListing when one is given', async () => {
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
      category: 'data',
      status: 'active' as const,
      ...rowAt,
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
      title: 'Tape',
      description: 'A tape of prints',
      offerType: 'one_time',
      assetId: 'USDT',
      price: '10',
      category: ' data ',
    });
    expect(created.offerType).toBe('one_time');
    expect(values[0]?.at(-1)).toBe('data');
    expect(values[0]?.at(-2)).toBeNull();
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
      ...rowAt,
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
    expect(values[0]).not.toContain('bots');
    await expect(
      svc.createListing({
        userId: USER,
        title: 'Mean',
        description: 'A listed strategy',
        offerType: 'subscription',
        assetId: 'USDT',
        price: '12.50',
        periodSeconds: 86_400,
        category: 'bots',
      }),
    ).rejects.toMatchObject({ code: 'market.category_invalid' });
    expect(values).toHaveLength(1);
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
      category: 'data',
      status: 'active' as const,
      ...rowAt,
    };
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls += 1;
      bound.push(values);
      if (calls === 1) {
        expect(strings.join(' ')).toContain("offer_type = 'one_time'");
        expect(strings.join(' ')).toContain('category =');
        expect(strings.join(' ')).not.toContain('cursor');
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
    const page = await svc.publicListingsByCategory({ category: 'data', limit: 10 });
    expect(page).toEqual([expect.objectContaining({ id: LISTING, category: 'data', offerType: 'one_time' })]);
    expect(bound[0]).toContain('data');
    expect(bound[0]).toContain(30);
  });

  it('refuses setListingCategory before sql when the key, reason, scope, or slug is bad', async () => {
    const sql = refusingSql();
    const svc = service({ sql });
    const input = {
      actorId: OP,
      actorScope: 'market:ops',
      listingId: LISTING,
      category: 'bots',
      reason: 'catalogue desk filed this under bots',
      businessKey: 'cat-bots-1',
    };
    await expect(svc.setListingCategory({ ...input, actorScope: 'market:write' })).rejects.toMatchObject({
      code: 'market.ops_required',
    });
    await expect(svc.setListingCategory({ ...input, businessKey: '  ' })).rejects.toMatchObject({
      code: 'market.category_business_key_required',
    });
    await expect(svc.setListingCategory({ ...input, reason: 'short' })).rejects.toMatchObject({
      code: 'market.category_reason_short',
    });
    await expect(svc.setListingCategory({ ...input, category: 'signals' })).rejects.toMatchObject({
      code: 'market.category_invalid',
    });
    expect(sql).not.toHaveBeenCalled();
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
    category: 'bots',
  };

  it('serves listingCategories to an anonymous caller', async () => {
    const commerce = { listingCategories: vi.fn(() => [...MARKET_LISTING_CATEGORIES]) };
    const reply = await createMarketRouter({} as never, commerce as never)
      .createCaller(anonymous())
      .listingCategories();
    expect(reply.categories).toEqual([...MARKET_LISTING_CATEGORIES]);
  });

  it('maps a blank category to a precondition failure', async () => {
    const commerce = {
      publicListingsByCategory: vi.fn(() => {
        throw new MarketError('market.listing_category_unset', 'market.listing_category_unset');
      }),
    };
    await expect(
      createMarketRouter({} as never, commerce as never)
        .createCaller(anonymous())
        .listingsByCategory({ limit: 10 }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'market.listing_category_unset' });
  });

  it('maps an unknown category to a bad request and passes limit through', async () => {
    const commerce = {
      publicListingsByCategory: vi.fn(async () => {
        throw new MarketError('market.category_invalid', 'market.category_invalid');
      }),
    };
    await expect(
      createMarketRouter({} as never, commerce as never)
        .createCaller(anonymous())
        .listingsByCategory({ category: 'signals', limit: 10 }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'market.category_invalid' });
    expect(commerce.publicListingsByCategory).toHaveBeenCalledWith({ category: 'signals', limit: 10 });
  });

  it('refuses createNonStrategyListing without market:write and never calls commerce', async () => {
    const commerce = { createNonStrategyListing: vi.fn(async () => listed) };
    const reader = principal({ scopes: ['market:read'] });
    await expect(
      createMarketRouter({} as never, commerce as never)
        .createCaller(signed(reader))
        .createNonStrategyListing({ title: 'Tape', description: 'A tape of prints', assetId: 'USDT', price: '10', category: 'bots' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(commerce.createNonStrategyListing).not.toHaveBeenCalled();
  });

  it('creates a non-strategy listing for the signed vendor', async () => {
    const commerce = { createNonStrategyListing: vi.fn(async () => listed) };
    const reply = await createMarketRouter({} as never, commerce as never)
      .createCaller(signed())
      .createNonStrategyListing({ title: 'Tape', description: 'A tape of prints', assetId: 'USDT', price: '10', category: 'bots' });
    expect(reply).toEqual(listed);
    expect(commerce.createNonStrategyListing).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER, category: 'bots', price: '10' }),
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
          category: 'bots',
          periodSeconds: 86_400,
        } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(commerce.createNonStrategyListing).not.toHaveBeenCalled();
  });

  it('refuses setListingCategory without MFA and without market:ops', async () => {
    const commerce = { setListingCategory: vi.fn() };
    const operator = principal({ userId: OP, sub: OP, scopes: ['market:ops'], mfa: false });
    const body = {
      listingId: LISTING,
      category: 'bots',
      reason: 'catalogue desk filed this under bots',
      businessKey: 'cat-bots-1',
    };
    await expect(
      createMarketRouter({} as never, commerce as never)
        .createCaller(signed(operator))
        .ops.setListingCategory(body),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const writer = principal({ scopes: ['market:write'], mfa: true });
    await expect(
      createMarketRouter({} as never, commerce as never)
        .createCaller(signed(writer))
        .ops.setListingCategory(body),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(commerce.setListingCategory).not.toHaveBeenCalled();
  });

  it('sets the category as the signed operator', async () => {
    const filed = {
      listingId: LISTING,
      category: 'bots',
      actorId: OP,
      reason: 'catalogue desk filed this under bots',
      businessKey: 'cat-bots-1',
      recordedAt: '2026-10-23T00:00:00.000Z',
    };
    const commerce = { setListingCategory: vi.fn(async () => filed) };
    const operator = principal({ userId: OP, sub: OP, scopes: ['market:ops'], mfa: true });
    const reply = await createMarketRouter({} as never, commerce as never)
      .createCaller(signed(operator))
      .ops.setListingCategory({
        listingId: LISTING,
        category: 'bots',
        reason: 'catalogue desk filed this under bots',
        businessKey: 'cat-bots-1',
      });
    expect(reply).toEqual(filed);
    expect(commerce.setListingCategory).toHaveBeenCalledWith({
      actorId: OP,
      actorScope: 'market:ops',
      listingId: LISTING,
      category: 'bots',
      reason: 'catalogue desk filed this under bots',
      businessKey: 'cat-bots-1',
    });
  });
});
