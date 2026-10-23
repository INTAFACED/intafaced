import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { CommerceService } from './commerce-service.js';
import { decimalPriceFromDriver } from './commerce-price.js';
import { createMarketRouter, listingDetailOut } from '../router.js';
import { ReviewsService, REVIEW_MEAN_ROUNDING } from '../reviews/reviews-service.js';
import { userCopy } from '../user-copy.js';
import { MarketError } from '../vendor-service.js';

/**
 * MC-market-01 — public listing by id.
 * The shopfront read carries terms, the seller's public profile, the active
 * listing count and the review summary. It carries no seller user id and no
 * performance figure. Blank commission refuses before any read.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const SELLER = '99999999-9999-4999-8999-999999999999';
const VENDOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LISTING = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SECRET = 'public-listing-edge-secret-long-enough';
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

const profile = {
  id: VENDOR,
  displayName: 'Ada Prints',
  description: 'Prints, not advice',
  createdAt: '2026-01-01T00:00:00.000Z',
};

const rowAt = {
  created_at: new Date('2026-02-01T00:00:00.000Z'),
  updated_at: new Date('2026-02-02T00:00:00.000Z'),
};

function listingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: LISTING,
    vendor_id: VENDOR,
    title: 'Tape',
    description: 'A tape of prints',
    offer_type: 'one_time',
    asset_id: 'USDT',
    price: '12.50',
    period_seconds: null,
    status: 'active',
    ...rowAt,
    user_id: SELLER,
    ...overrides,
  };
}

function scripted(pages: unknown[][]) {
  const queue = [...pages];
  return vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error('unexpected sql');
    return next;
  });
}

function vendors(overrides: Record<string, unknown> = {}) {
  return {
    listingEligibility: vi.fn(async () => ({ listed: true, vendorId: VENDOR })),
    entitledListingRefs: vi.fn(async () => new Set([LISTING])),
    publicProfile: vi.fn(async () => profile),
    ...overrides,
  };
}

function commerce(sql: unknown, vendor: unknown, commissionBps: number | null = 250) {
  return new CommerceService(sql as never, vendor as never, {} as never, { commissionBps });
}

function textsOf(sql: { mock: { calls: unknown[][] } }): string[] {
  return sql.mock.calls.map((call) => (call[0] as TemplateStringsArray).join(' '));
}

describe('publicListing refuses a blank commission and hides what is not on the shopfront', () => {
  it('refuses before sql when the commission rate is blank', async () => {
    const sql = scripted([]);
    const vendor = vendors();
    await expect(commerce(sql, vendor, null).publicListing(LISTING)).rejects.toMatchObject({
      code: 'market.commission_not_configured',
    });
    expect(sql).not.toHaveBeenCalled();
    expect(vendor.listingEligibility).not.toHaveBeenCalled();
  });

  it('returns null for a missing, archived, taken-down or period-less subscription row', async () => {
    for (const page of [
      [],
      [listingRow({ status: 'archived' })],
      [listingRow({ status: 'taken_down' })],
      [listingRow({ offer_type: 'subscription', period_seconds: null })],
    ]) {
      const sql = scripted([page]);
      const vendor = vendors();
      await expect(commerce(sql, vendor).publicListing(LISTING)).resolves.toBeNull();
      expect(vendor.listingEligibility).not.toHaveBeenCalled();
      expect(textsOf(sql).join(' ')).not.toMatch(/user_id/);
    }
  });

  it('returns null when the vendor is not listed, the slot is dead, or the profile is hidden', async () => {
    const unlisted = scripted([[listingRow()]]);
    const unlistedVendors = vendors({ listingEligibility: vi.fn(async () => ({ listed: false, vendorId: VENDOR })) });
    await expect(commerce(unlisted, unlistedVendors).publicListing(LISTING)).resolves.toBeNull();
    expect(unlistedVendors.entitledListingRefs).not.toHaveBeenCalled();

    const deadSlot = scripted([[listingRow()], []]);
    const deadVendors = vendors();
    await expect(commerce(deadSlot, deadVendors).publicListing(LISTING)).resolves.toBeNull();
    expect(deadVendors.publicProfile).not.toHaveBeenCalled();

    const hidden = scripted([[listingRow()], [{ id: 'slot' }]]);
    const hiddenVendors = vendors({ publicProfile: vi.fn(async () => null) });
    await expect(commerce(hidden, hiddenVendors).publicListing(LISTING)).resolves.toBeNull();
    expect(textsOf(hidden).join('\n')).not.toMatch(/count\(\*\)/);
  });

  it('does not turn an unreadable stake into a missing listing', async () => {
    const sql = scripted([[listingRow()]]);
    const vendor = vendors({
      listingEligibility: vi.fn(async () => {
        throw new MarketError('market.stake_unavailable', 'market.stake_unavailable');
      }),
    });
    await expect(commerce(sql, vendor).publicListing(LISTING)).rejects.toMatchObject({ code: 'market.stake_unavailable' });
  });

  it('returns the listing, the public profile and the active count, with no seller user id', async () => {
    const sql = scripted([[listingRow({ offer_type: 'subscription', period_seconds: '86400' })], [{ id: 'slot' }], [{ n: '2' }]]);
    const detail = await commerce(sql, vendors()).publicListing(LISTING);
    expect(detail?.vendor).toEqual(profile);
    expect(detail?.activeListingCount).toBe(2);
    expect(detail?.listing.price).toBe(decimalPriceFromDriver('12.50'));
    expect(typeof detail?.listing.price).toBe('string');
    expect(detail?.listing.periodSeconds).toBe(86400);
    expect(detail?.listing.offerType).toBe('subscription');
    expect(JSON.stringify(detail)).not.toContain(SELLER);
    expect(textsOf(sql).join('\n')).not.toMatch(/user_id/);
    expect(textsOf(sql)[0]).toContain('price::text');
  });

  it('refuses an unreadable active count instead of inventing one', async () => {
    const sql = scripted([[listingRow()], [{ id: 'slot' }], [{ n: '0' }]]);
    await expect(commerce(sql, vendors()).publicListing(LISTING)).rejects.toMatchObject({
      code: 'market.vendor_listing_count_unreadable',
    });
  });
});

describe('summaryForListing counts scores and nothing else', () => {
  it('returns a null mean when there are no reviews, never the string 0', async () => {
    const sql = scripted([[]]);
    const summary = await new ReviewsService(sql as never).summaryForListing(LISTING);
    expect(summary).toEqual({ count: '0', mean: null, meanRounding: REVIEW_MEAN_ROUNDING });
    expect(textsOf(sql)[0]).toContain('SELECT score FROM market.reviews WHERE listing_id =');
    expect(textsOf(sql)[0]).not.toMatch(/buyer/);
  });

  it('averages the stored scores as a decimal string', async () => {
    const sql = scripted([[{ score: 5 }, { score: 3 }]]);
    const summary = await new ReviewsService(sql as never).summaryForListing(LISTING);
    expect(summary.count).toBe('2');
    expect(typeof summary.mean).toBe('string');
    expect(summary.mean).not.toBe('0');
    expect(summary.mean).toBe(decimalPriceFromDriver('4'));
  });
});

describe('market.listing on the router', () => {
  function mount(
    sql: ReturnType<typeof scripted>,
    reviewSql: ReturnType<typeof scripted>,
    commissionBps: number | null = 250,
    withReviews = true,
  ) {
    const svc = commerce(sql, vendors(), commissionBps);
    const reviews = withReviews ? new ReviewsService(reviewSql as never) : undefined;
    return createMarketRouter({} as never, svc, undefined, undefined, reviews).createCaller(anonymous());
  }

  it('serves the detail to an anonymous caller and labels performance unreported', async () => {
    const caller = mount(scripted([[listingRow()], [{ id: 'slot' }], [{ n: '1' }]]), scripted([[{ score: 5 }]]));
    const reply = await caller.listing({ listingId: LISTING });
    expect(listingDetailOut.parse(reply)).toEqual(reply);
    expect(reply.terms).toEqual({
      offerType: reply.listing.offerType,
      assetId: reply.listing.assetId,
      price: reply.listing.price,
      periodSeconds: reply.listing.periodSeconds,
    });
    expect(reply.reviews.count).toBe('1');
    expect(reply.reviews.mean).not.toBeNull();
    expect(reply.performance).toEqual({ reported: false });
    expect(JSON.stringify(reply.performance)).not.toMatch(/[0-9]/);
    expect(JSON.stringify(reply)).not.toContain(SELLER);
    expect(JSON.stringify(reply)).not.toContain('userId');
  });

  it('answers an unknown id with the typed not-found and does not read reviews', async () => {
    const reviewSql = scripted([]);
    const caller = mount(scripted([[]]), reviewSql);
    await expect(caller.listing({ listingId: LISTING })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: userCopy('market.listing_not_found'),
    });
    expect(reviewSql).not.toHaveBeenCalled();
  });

  it('refuses a blank commission by name', async () => {
    const sql = scripted([]);
    const caller = mount(sql, scripted([]), null);
    await expect(caller.listing({ listingId: LISTING })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'market.commission_not_configured',
    });
    expect(sql).not.toHaveBeenCalled();
  });

  it('refuses an unreadable stake as retryable, not as not-found', async () => {
    const sql = scripted([[listingRow()]]);
    const vendor = vendors({
      listingEligibility: vi.fn(async () => {
        throw new MarketError('market.stake_unavailable', 'market.stake_unavailable');
      }),
    });
    const caller = createMarketRouter(
      {} as never,
      commerce(sql, vendor),
      undefined,
      undefined,
      new ReviewsService(scripted([]) as never),
    ).createCaller(signed());
    await expect(caller.listing({ listingId: LISTING })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'market.stake_unavailable',
    });
  });

  it('does not invent a review summary when reviews are unwired', async () => {
    const caller = mount(scripted([[listingRow()], [{ id: 'slot' }], [{ n: '1' }]]), scripted([]), 250, false);
    await expect(caller.listing({ listingId: LISTING })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'market.reviews is not wired in this process',
    });
  });

  it('rejects a blank listing id before any read', async () => {
    const sql = scripted([]);
    const caller = mount(sql, scripted([]));
    await expect(caller.listing({ listingId: ' ' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(sql).not.toHaveBeenCalled();
  });
});
