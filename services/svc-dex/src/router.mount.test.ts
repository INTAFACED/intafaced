import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { checkAccess, SANCTIONS_REGIONS_ENV, SANCTIONS_SOURCE_ENV, SCREENING_REVIEWED_EMPTY } from '@intafaced/config';
import { createEdgeContext, encodePrincipal } from '@intafaced/contracts';
import { parseAmount as amt, type Amount } from '@intafaced/ledger-client/money';
import { createDexRouter } from './router.js';
import { MarketDataSource } from './quote/market-data-source.js';
import type { BookLevel, ChainFinality, TimestampedBook, VenueKind } from './quote/venue.js';
import { VenueUnavailableError } from './quote/venue.js';
import { venuesFor, type VenueSetEnv } from './quote/venue-set.js';

/**
 * THE MOUNT BOUNDARY, for svc-dex (docs/decisions/mount-boundary.md).
 *
 * `quote-service.test.ts` proves the sourcing rule in isolation: a price is
 * never invented. What it cannot prove is that the rule survives the mount —
 * that the procedure a caller actually reaches enforces it, that a refusal
 * becomes the right tRPC code rather than a 500, and that the surface is
 * genuinely open to somebody holding nothing.
 *
 * So the context here comes from `createEdgeContext` over real headers, exactly
 * as `index.ts` builds it, rather than from a `Context` literal — a literal
 * would keep passing on a service that had quietly started trusting an unsigned
 * header.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS BEING DEFENDED, PRECISELY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two claims, and they pull in opposite directions:
 *
 *   · **The DEX is permissionless.** §503 — no login, no KYC tier, no account
 *     gate beyond a wallet, because the platform never holds the asset. A test
 *     that only asserted `checkAccess` in the abstract would not notice the day
 *     a scoped procedure replaced a public one at the mount.
 *   · **A permissionless surface is still not allowed to lie.** Openness makes
 *     the honesty requirement stricter, not looser: the caller has no account,
 *     no support channel and no recourse. If this door hands out a stale price,
 *     nobody is on the other end to correct it.
 *
 * Both are asserted below against the same router.
 */

/** Length-checked by `createEdgeContext` before it will mount anything. */
const SECRET = 'a-dex-mount-test-edge-secret-long-enough';

/**
 * Quote tests need a configured screening answer or the hosted door refuses.
 * `none` is the attributed-empty token, not a region list.
 */
const priorRegions = process.env[SANCTIONS_REGIONS_ENV];
const priorSource = process.env[SANCTIONS_SOURCE_ENV];
beforeAll(() => {
  process.env[SANCTIONS_REGIONS_ENV] = SCREENING_REVIEWED_EMPTY;
  process.env[SANCTIONS_SOURCE_ENV] = 'counsel-memo-ref';
});
afterAll(() => {
  if (priorRegions === undefined) delete process.env[SANCTIONS_REGIONS_ENV];
  else process.env[SANCTIONS_REGIONS_ENV] = priorRegions;
  if (priorSource === undefined) delete process.env[SANCTIONS_SOURCE_ENV];
  else process.env[SANCTIONS_SOURCE_ENV] = priorSource;
});

const NOW = new Date('2026-07-29T12:00:00.000Z');
const at = (msAgo: number) => new Date(NOW.getTime() - msAgo);

const edgeContext = createEdgeContext({ secret: SECRET, serviceName: 'svc-dex' });

/** No credentials of any kind — a caller who simply found the port. */
const anonymous = (region = 'DE') => edgeContext({ headers: { 'x-intafaced-region': region }, id: 'req-anon' });

/**
 * An unsigned principal, self-asserted.
 *
 * It must be DROPPED rather than honoured — and the quote must be served
 * anyway, because this surface never needed a principal to begin with. That
 * combination is the point: forging a principal at a permissionless door buys
 * the forger nothing, so there is nothing here to attack.
 */
const forged = () =>
  edgeContext({
    headers: {
      'x-intafaced-principal': encodePrincipal({
        sub: '11111111-1111-4111-8111-111111111111',
        userId: '11111111-1111-4111-8111-111111111111',
        sid: '22222222-2222-4222-8222-222222222222',
        scopes: ['admin:treasury'],
        tier: 'institutional',
        mfa: true,
        expiresAt: new Date(NOW.getTime() + 60_000),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
      'x-intafaced-region': 'DE',
    },
    id: 'req-forged',
  });

const level = (price: string, qty: string): BookLevel => [amt(price), amt(qty)];

interface FakeVenueOptions {
  id: string;
  kind?: VenueKind;
  feeBps?: number;
  bids?: BookLevel[];
  asks?: BookLevel[];
  /** How old the book is at `NOW`. */
  ageMs?: number;
  fails?: Error;
  chainFinality?: ChainFinality;
}

/**
 * Extends the REAL `MarketDataSource`, so the capability declaration, the health
 * tracking and the `submit` refusal under test are the shipped implementations
 * rather than a mock of them. Only the transport is faked.
 */
class FakeVenue extends MarketDataSource {
  readonly id: string;
  readonly kind: VenueKind;
  readonly feeBps: number;
  readonly settlementCost: Amount = 0n;
  readonly #options: FakeVenueOptions;

  constructor(options: FakeVenueOptions) {
    super({ quoteTtlMs: 2_000 });
    this.#options = options;
    this.id = options.id;
    this.kind = options.kind ?? 'external-dex';
    this.feeBps = options.feeBps ?? 0;
  }

  protected async fetchDepth(symbol: string): Promise<TimestampedBook> {
    if (this.#options.fails) throw this.#options.fails;
    const protocol = this.kind === 'external-dex' || this.kind === 'amm';
    return {
      venueId: this.id,
      symbol,
      bids: this.#options.bids ?? [],
      asks: this.#options.asks ?? [],
      observedAt: at(this.#options.ageMs ?? 0),
      sequence: 1,
      ...(protocol ? { chainFinality: this.#options.chainFinality ?? 'finalized' } : {}),
    };
  }
}

/** A venue with real depth on both sides, read just now. */
const liveVenue = (id = 'intachain-clob', ageMs = 0) => new FakeVenue({ id, ageMs, bids: [level('99', '10')], asks: [level('101', '10')] });

/** A hide list that was read and is empty: every market is listed. */
const NOTHING_HIDDEN = { read: async () => ({ asOf: NOW.toISOString(), pools: [], markets: [] }) };

function routerWith(venues: (region: string) => FakeVenue[]) {
  return createDexRouter({ venues, maxAgeMs: 2_000, depth: 50, hideList: NOTHING_HIDDEN, now: () => NOW });
}

const buy = { symbol: 'IFC-USD', side: 'buy' as const, qty: '1' };

// ── The permissionless claim, at the mount ───────────────────────────────────

describe('svc-dex mount — the DEX is permissionless', () => {
  it('refuses an unset screening list before building venues or presenting a quote', async () => {
    let venuesBuilt = 0;
    vi.stubEnv(SANCTIONS_REGIONS_ENV, '   ');
    vi.stubEnv(SANCTIONS_SOURCE_ENV, undefined);
    vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', 'true');
    try {
      await expect(
        routerWith(() => {
          venuesBuilt += 1;
          return [liveVenue()];
        })
          .createCaller(anonymous())
          .quote(buy),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', cause: { code: 'denied.screening_unconfigured' } });
      expect(venuesBuilt).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  /**
   * THE ONE THE PRODUCT CLAIM RESTS ON.
   *
   * The brief for this branch names it directly: the permissionless access path
   * must still resolve to `allowed.permissionless`. Asserted on the decision
   * itself AND on the procedure, because the two can drift — `checkAccess` can
   * keep returning the right code long after the mount stopped calling it.
   */
  it('resolves the access decision to allowed.permissionless, and serves on it', async () => {
    const decision = checkAccess({ module: 'dex', plane: 'protocol', region: 'DE', kycTier: 'none' });
    expect(decision.allowed).toBe(true);
    expect(decision.code).toBe('allowed.permissionless');

    const quoted = await routerWith(() => [liveVenue()])
      .createCaller(anonymous())
      .quote(buy);

    expect(quoted.route.filledQty).toBe('1');
  });

  it('serves a caller holding no principal, no key and no KYC tier', async () => {
    const ctx = anonymous();
    expect(ctx.principal).toBeNull();

    await expect(
      routerWith(() => [liveVenue()])
        .createCaller(ctx)
        .quote(buy),
    ).resolves.toMatchObject({ symbol: 'IFC-USD', side: 'buy' });
  });

  it('drops a forged principal and still answers — a forged principal buys nothing here', async () => {
    const ctx = forged();
    expect(ctx.principal).toBeNull();

    await expect(
      routerWith(() => [liveVenue()])
        .createCaller(ctx)
        .quote(buy),
    ).resolves.toMatchObject({ symbol: 'IFC-USD' });
  });

  it('admits every KYC tier equally — there is no ladder to climb', () => {
    for (const kycTier of ['none', 'basic', 'full', 'institutional'] as const) {
      expect(checkAccess({ module: 'dex', plane: 'protocol', region: 'DE', kycTier }).allowed, kycTier).toBe(true);
    }
  });

  /**
   * The factory is region-aware for a reason, and this is it: the region this
   * service admitted must be the region it reads upstream as. Screening at the
   * front door and then calling an upstream as an unknown region would leave the
   * two disagreeing about who is being served.
   */
  it('builds venues for the region the door actually screened', async () => {
    const seen: string[] = [];
    await routerWith((region) => {
      seen.push(region);
      return [liveVenue()];
    })
      .createCaller(anonymous('GB'))
      .quote(buy);

    expect(seen).toEqual(['GB']);
  });
});

// ── A fresh quote succeeds, over the wire ────────────────────────────────────

describe('svc-dex mount — a live quote', () => {
  it('returns a route built from a book read inside the ceiling', async () => {
    const quoted = await routerWith(() => [liveVenue()])
      .createCaller(anonymous())
      .quote(buy);

    expect(quoted.route.legs).toHaveLength(1);
    expect(quoted.route.legs[0]?.venue).toBe('intachain-clob');
    expect(quoted.ageMs).toBe(0);
    expect(quoted.maxAgeMs).toBe(2_000);
    expect(quoted.route.kind).toBe('quote');
    expect(quoted.executable).toBe(true);
    expect(quoted.route.executable).toBe(true);
  });

  /**
   * Money crosses the wire as decimal STRINGS. A JSON number would round the
   * eighteenth decimal away, and the eighteenth decimal is where a split route
   * stops adding up.
   */
  it('reports every amount as a decimal string, never a number', async () => {
    const quoted = await routerWith(() => [liveVenue()])
      .createCaller(anonymous())
      .quote(buy);

    expect(typeof quoted.route.totalQuoteAmount).toBe('string');
    expect(typeof quoted.route.filledQty).toBe('string');
    expect(typeof quoted.venues[0]?.quoteAmount).toBe('string');
    expect(typeof quoted.venues[0]?.settlementCost).toBe('string');
    for (const leg of quoted.route.legs) {
      expect(typeof leg.effectivePrice).toBe('string');
      expect(typeof leg.quoteAmount).toBe('string');
    }
  });

  /**
   * "Best of N" must not mean "the only one that answered".
   *
   * Two venues configured, one down: the survivor's price is real, and the
   * response says out loud that it is a survivor. A client that renders "best
   * execution across venues" can check one boolean before saying so.
   */
  it('tells the caller when a best-of-N was really a best-of-one', async () => {
    const quoted = await routerWith(() => [
      liveVenue(),
      new FakeVenue({ id: 'venue-down', fails: new VenueUnavailableError('venue-down', 'unreachable', 'connection refused') }),
    ])
      .createCaller(anonymous())
      .quote(buy);

    expect(quoted.venuesConfigured).toBe(2);
    expect(quoted.venues).toHaveLength(1);
    expect(quoted.degraded).toBe(true);
    expect(quoted.singleVenue).toBe(true);
    expect(quoted.unavailable).toEqual([expect.objectContaining({ venueId: 'venue-down', reason: 'unreachable' })]);
    expect(quoted.executable).toBe(false);
    expect(quoted.route.executable).toBe(false);
    expect(quoted.route.kind).toBe('quote');
    expect(quoted.nonExecutableReason).toBe('degraded');
  });

  /**
   * Custody, disclosed rather than hidden. A permissionless caller may be quoted
   * our own book — it sometimes genuinely has the better price — but a fill
   * there settles through the ledger, which is not self-custody. The response
   * carries the fact so a client wanting only sovereign liquidity can filter.
   */
  it('discloses which legs would settle outside the user own custody', async () => {
    const quoted = await routerWith(() => [
      new FakeVenue({ id: 'internal-book', kind: 'internal', bids: [level('99', '10')], asks: [level('100', '10')] }),
    ])
      .createCaller(anonymous())
      .quote(buy);

    expect(quoted.custodialLegs).toBe(true);
    expect(quoted.venues[0]).toMatchObject({ plane: 'fiat', custodial: true });
    expect(quoted.executable).toBe(false);
    expect(quoted.nonExecutableReason).toBe('custodial_settlement');
    expect(quoted.internalBook).toMatchObject({ enabled: true, custodial: true, plane: 'fiat', amm: false });
  });

  it('health names the internal book custodial rather than claiming custodial:false', async () => {
    const health = await createDexRouter({
      venues: () => [new FakeVenue({ id: 'internal-book', kind: 'internal', bids: [level('99', '10')], asks: [level('100', '10')] })],
      maxAgeMs: 2_000,
      depth: 50,
      now: () => NOW,
      internalBookEnabled: true,
    })
      .createCaller(anonymous())
      .health();

    expect(health.internalBook).toEqual({
      enabled: true,
      custodial: true,
      plane: 'fiat',
      venueKind: 'internal',
      amm: false,
    });
    expect(health).not.toHaveProperty('custodial');
    expect(health.bestEx).toEqual({ ok: true, claimed: false });
    expect(health.externalVenueWired).toBe(false);
    expect(health.ammVenueWired).toBe(false);
  });

  it('live quote ranks venues without claiming certified best execution', async () => {
    const quoted = await routerWith(() => [
      liveVenue('a'),
      new FakeVenue({ id: 'down', fails: new VenueUnavailableError('down', 'unreachable', 'down unreachable') }),
    ])
      .createCaller(anonymous())
      .quote(buy);

    expect(quoted.venuesConfigured).toBe(2);
    expect(quoted.degraded).toBe(true);
    expect(quoted.singleVenue).toBe(true);
    expect(quoted.venues.length).toBeGreaterThan(0);
    expect(quoted.bestEx).toEqual({ ok: true, claimed: false });
  });
});

// ── Every refusal, with the code a client branches on ────────────────────────

describe('svc-dex mount — a quote it cannot source is refused, never guessed', () => {
  /**
   * The status codes are not decoration. An unreachable venue is a 503 somebody
   * should be paged about; an empty book is a fact about the market that no
   * amount of paging fixes. Collapsing them would page someone at 3am because
   * nobody wanted to sell.
   */
  it('refuses unset DEX_QUOTE_DEPTH with PRECONDITION_FAILED and dex.quote.depth_unset — never invent 50', async () => {
    await expect(
      createDexRouter({ venues: () => [liveVenue()], maxAgeMs: 2_000, now: () => NOW })
        .createCaller(anonymous())
        .quote(buy),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('dex.quote.depth_unset'),
    });
  });

  it('refuses unset QUOTE_MAX_AGE_MS with PRECONDITION_FAILED and dex.quote.max_age_unset — never invent 2000', async () => {
    await expect(
      createDexRouter({ venues: () => [liveVenue()], depth: 50, now: () => NOW })
        .createCaller(anonymous())
        .quote(buy),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('dex.quote.max_age_unset'),
    });
  });

  it('refuses unset internal-book fee with SERVICE_UNAVAILABLE and dex.internal_book_fee_unset — never invent 20', async () => {
    const env: VenueSetEnv = {
      INDEXER_URL: 'http://indexer.test',
      MATCHING_URL: 'http://matching.test',
      QUOTE_MAX_AGE_MS: 2_000,
      DEX_INTERNAL_BOOK_ENABLED: true,
      DEX_INTERNAL_BOOK_FEE_BPS: undefined,
      DEX_EXTERNAL_VENUES: [],
    };
    await expect(
      createDexRouter({ venues: (region) => venuesFor(env, region), maxAgeMs: 2_000, depth: 50, hideList: NOTHING_HIDDEN, now: () => NOW })
        .createCaller(anonymous())
        .quote(buy),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: expect.stringContaining('dex.internal_book_fee_unset'),
    });
  });

  it('refuses a stale book with SERVICE_UNAVAILABLE and dex.quote.stale', async () => {
    await expect(
      routerWith(() => [liveVenue('intachain-clob', 2_001)])
        .createCaller(anonymous())
        .quote(buy),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: expect.stringContaining('dex.quote.stale'),
    });
  });

  it('refuses missing finality with SERVICE_UNAVAILABLE — not a successful route', async () => {
    await expect(
      routerWith(() => [
        new FakeVenue({
          id: 'intachain-clob',
          chainFinality: 'unknown',
          bids: [level('99', '10')],
          asks: [level('101', '10')],
        }),
      ])
        .createCaller(anonymous())
        .quote(buy),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: expect.stringContaining('dex.quote.missing_finality'),
    });
  });

  it('refuses a reorg-unconfirmed book with SERVICE_UNAVAILABLE — not a fill', async () => {
    await expect(
      routerWith(() => [
        new FakeVenue({
          id: 'intachain-clob',
          chainFinality: 'unconfirmed',
          bids: [level('99', '10')],
          asks: [level('101', '10')],
        }),
      ])
        .createCaller(anonymous())
        .quote(buy),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: expect.stringContaining('dex.quote.reorg_unconfirmed'),
    });
  });

  it('refuses an unavailable venue rather than guessing a price', async () => {
    await expect(
      routerWith(() => [
        new FakeVenue({ id: 'venue-down', fails: new VenueUnavailableError('venue-down', 'unreachable', 'connection refused') }),
      ])
        .createCaller(anonymous())
        .quote(buy),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: expect.stringContaining('dex.quote.no_venue_available'),
    });
  });

  it('refuses with NOT_FOUND when the books are fresh and nothing is resting', async () => {
    await expect(
      routerWith(() => [new FakeVenue({ id: 'empty', bids: [level('99', '10')], asks: [] })])
        .createCaller(anonymous())
        .quote(buy),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining('dex.quote.no_liquidity'),
    });
  });

  it('refuses rather than answering when no venue is wired at all', async () => {
    await expect(
      routerWith(() => [])
        .createCaller(anonymous())
        .quote(buy),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: expect.stringContaining('dex.quote.no_venue_configured'),
    });
  });

  /**
   * A refusal must carry WHY. "Why can you not quote me" is the first question,
   * and whoever is on call should get the answer from the error rather than from
   * a log search.
   */
  it('names the venue and the reason in the refusal', async () => {
    await expect(
      routerWith(() => [
        new FakeVenue({ id: 'venue-down', fails: new VenueUnavailableError('venue-down', 'not_ready', 'projected no chain state') }),
      ])
        .createCaller(anonymous())
        .quote(buy),
    ).rejects.toMatchObject({
      message: expect.stringContaining('venue-down'),
    });
  });
});

// ── The calculator, kept apart from the quote ────────────────────────────────

describe('svc-dex mount — routePreview is arithmetic, not a price', () => {
  /**
   * `quote` used to take `quotes: []` over the wire and route whatever the
   * CALLER supplied. The arithmetic was real; the prices came from nowhere. The
   * old behaviour survives under a name that cannot be mistaken for a price,
   * because the arithmetic is genuinely useful and the NAME was the defect.
   *
   * This asserts the two are separate procedures with separate inputs — so a
   * client cannot reach the caller-supplied path by calling `quote`.
   */
  it('routes caller-supplied quotes without touching a venue', async () => {
    let venuesBuilt = 0;
    const preview = await routerWith(() => {
      venuesBuilt += 1;
      return [liveVenue()];
    })
      .createCaller(anonymous())
      .routePreview({
        side: 'buy',
        qty: '1',
        quotes: [{ venue: 'made-up', kind: 'book', fillableQty: '1', quoteAmount: '100', feeBps: 0, settlementCost: '0' }],
      });

    expect(preview.legs[0]?.venue).toBe('made-up');
    expect(preview.kind).toBe('preview');
    expect(preview.executable).toBe(false);
    // It sourced nothing, which is exactly why it is not a quote.
    expect(venuesBuilt).toBe(0);
  });

  it('rejects a caller-supplied quotes array on the real quote procedure', async () => {
    await expect(
      routerWith(() => [liveVenue()])
        .createCaller(anonymous())
        // @ts-expect-error — `quote` takes a symbol and a size. There is no
        // input by which a caller can inject a price, and that is the fix.
        .quote({ ...buy, quotes: [{ venue: 'made-up', kind: 'book', fillableQty: '1', quoteAmount: '1' }] }),
    ).resolves.toMatchObject({ symbol: 'IFC-USD' });
  });
});
