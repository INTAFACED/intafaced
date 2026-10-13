import { describe, expect, it } from 'vitest';
import { parseAmount as amt, type Amount } from '@intafaced/ledger-client/money';
import { isRoutable } from '@intafaced/venue-adapter';
import { MarketDataSource } from './market-data-source.js';
import type { BookLevel, ChainFinality, TimestampedBook, VenueKind } from './venue.js';
import { VenueExecutionRefused, VenueUnavailableError } from './venue.js';
import { QuoteRefusedError, sourceQuote } from './quote-service.js';

/**
 * THE ONE PROPERTY WORTH TESTING HERE.
 *
 * **A price is never invented.** Every test below is a variation on that: fresh
 * data prices, everything else refuses, and a refusal says why. The arithmetic
 * is already covered by `router-quote.test.ts`; what these assert is the part
 * that decides whether a number is allowed to exist at all.
 *
 * The double extends the REAL `MarketDataSource`, so health tracking, the
 * capability declaration and the `submit` refusal under test are the shipped
 * implementations rather than a mock of them.
 *
 * The clock is injected everywhere. A staleness test that slept would be slow
 * and, worse, flaky in the direction that reports a pass — the failure would be
 * "the ceiling did not fire and the test did not notice".
 */

const NOW = new Date('2026-07-29T12:00:00.000Z');
const at = (msAgo: number) => new Date(NOW.getTime() - msAgo);

const level = (price: string, qty: string): BookLevel => [amt(price), amt(qty)];

interface FakeVenueOptions {
  id: string;
  kind?: VenueKind;
  feeBps?: number;
  settlementCost?: Amount;
  bids?: BookLevel[];
  asks?: BookLevel[];
  /** How old the book is at `NOW`. */
  ageMs?: number;
  /** Throw instead of answering. */
  fails?: Error;
  onFetch?: () => void;
  /** Protocol-plane books. Omit / `unknown` / `unconfirmed` must not price. */
  chainFinality?: ChainFinality;
}

class FakeVenue extends MarketDataSource {
  readonly id: string;
  readonly kind: VenueKind;
  readonly feeBps: number;
  readonly settlementCost: Amount;
  readonly #options: FakeVenueOptions;

  constructor(options: FakeVenueOptions) {
    super({ quoteTtlMs: 2_000 });
    this.#options = options;
    this.id = options.id;
    this.kind = options.kind ?? 'external-dex';
    this.feeBps = options.feeBps ?? 0;
    this.settlementCost = options.settlementCost ?? 0n;
  }

  protected async fetchDepth(symbol: string): Promise<TimestampedBook> {
    this.#options.onFetch?.();
    if (this.#options.fails) throw this.#options.fails;
    const protocol = this.kind === 'external-dex' || this.kind === 'amm';
    return {
      venueId: this.id,
      symbol,
      bids: this.#options.bids ?? [],
      asks: this.#options.asks ?? [],
      observedAt: at(this.#options.ageMs ?? 0),
      sequence: 1,
      // Test doubles of a usable protocol book default to finalized. Cases that
      // assert the honesty gap pass `unknown` / `unconfirmed` explicitly.
      ...(protocol ? { chainFinality: this.#options.chainFinality ?? 'finalized' } : {}),
    };
  }
}

const deps = (venues: FakeVenue[], maxAgeMs = 2_000) => ({ venues, maxAgeMs, depth: 50, now: () => NOW });
const buyOne = { symbol: 'IFC-USD', side: 'buy' as const, qty: amt('1') };

async function refusal(promise: Promise<unknown>): Promise<QuoteRefusedError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof QuoteRefusedError) return err;
    throw err;
  }
  throw new Error('expected a QuoteRefusedError, got a quote — a price was invented');
}

// ── A fresh quote succeeds ───────────────────────────────────────────────────

describe('a fresh book prices', () => {
  it('quotes from a book read inside the ceiling', async () => {
    const venue = new FakeVenue({ id: 'intachain-clob', asks: [level('100', '2')], ageMs: 10 });

    const quoted = await sourceQuote(deps([venue]), buyOne);

    expect(quoted.route.legs).toHaveLength(1);
    expect(quoted.route.legs[0]!.venue).toBe('intachain-clob');
    expect(quoted.route.filledQty).toBe('1');
    expect(quoted.route.unfilledQty).toBe('0');
    expect(quoted.route.totalQuoteAmount).toBe('100');
    expect(quoted.unavailable).toEqual([]);
    expect(quoted.degraded).toBe(false);
  });

  it('carries the age of the OLDEST book behind the route, and the ceiling it was judged against', async () => {
    // "As of" is not decoration. A client holding a quote needs to know how old
    // the worst input was, not the best.
    const fast = new FakeVenue({ id: 'fast', asks: [level('100', '1')], ageMs: 5 });
    const slow = new FakeVenue({ id: 'slow', asks: [level('101', '1')], ageMs: 900 });

    const quoted = await sourceQuote(deps([fast, slow]), { ...buyOne, qty: amt('2') });

    expect(quoted.route.legs.map((l) => l.venue)).toEqual(['fast', 'slow']);
    expect(quoted.ageMs).toBe(900);
    expect(quoted.asOf).toBe(at(900).toISOString());
    expect(quoted.maxAgeMs).toBe(2_000);
  });

  it('walks depth for the size rather than quoting the top of book', async () => {
    // 1 @ 100 then 2 @ 110 → 3 units cost 320. A router that quoted the top
    // would promise 300 and fill at 320.
    const venue = new FakeVenue({ id: 'v', asks: [level('100', '1'), level('110', '2')] });

    const quoted = await sourceQuote(deps([venue]), { ...buyOne, qty: amt('3') });

    expect(quoted.route.totalQuoteAmount).toBe('320');
    expect(quoted.venues[0]!.quoteAmount).toBe('320');
  });

  it('sells against bids, not asks', async () => {
    const venue = new FakeVenue({ id: 'v', bids: [level('99', '5')], asks: [level('101', '5')] });

    const quoted = await sourceQuote(deps([venue]), { symbol: 'IFC-USD', side: 'sell', qty: amt('2') });

    expect(quoted.route.totalQuoteAmount).toBe('198');
  });

  it.each([
    { kind: 'internal' as const, settlement: '0', net: '99' },
    { kind: 'amm' as const, settlement: '2', net: '97' },
  ])('reports net sell proceeds after the configured fee and $settlement settlement', async ({ kind, settlement, net }) => {
    const venue = new FakeVenue({
      id: 'fee-bearing',
      kind,
      bids: [level('100', '1')],
      feeBps: 100,
      settlementCost: amt(settlement),
    });
    const quoted = await sourceQuote(deps([venue]), { ...buyOne, side: 'sell' });

    expect(quoted.venues[0]).toMatchObject({ fillableQty: '1', quoteAmount: '100', feeBps: 100, settlementCost: settlement });
    expect(quoted.route.legs[0]).toMatchObject({ qty: '1', quoteAmount: net, effectivePrice: net });
    expect(quoted.route).toMatchObject({ filledQty: '1', unfilledQty: '0', totalQuoteAmount: net });
  });

  it('keeps buy cash cost separate from the fee deducted from received base', async () => {
    const venue = new FakeVenue({ id: 'pool', kind: 'amm', asks: [level('100', '1')], feeBps: 100, settlementCost: amt('2') });
    const quoted = await sourceQuote(deps([venue]), buyOne);

    // Gross venue base is 1; buyer receives 0.99 base and pays 102 quote.
    expect(quoted.venues[0]).toMatchObject({ fillableQty: '1', quoteAmount: '100', feeBps: 100 });
    expect(quoted.route.legs[0]).toMatchObject({ qty: '1', quoteAmount: '102', effectivePrice: '103.030303030303030303' });
    expect(quoted.route).toMatchObject({ filledQty: '1', unfilledQty: '0', totalQuoteAmount: '102' });
  });

  it('preserves exact tiny proceeds instead of reconstructing them from a rounded per-unit price', async () => {
    const venue = new FakeVenue({
      id: 'tiny',
      bids: [level('0.000000000000000002', '2'), level('0.000000000000000001', '1')],
      feeBps: 5000,
      settlementCost: amt('0.000000000000000001'),
    });
    const quoted = await sourceQuote(deps([venue]), { ...buyOne, side: 'sell', qty: amt('3') });

    // Five quote atoms, two fee atoms (existing integer truncation), one settlement atom.
    // Net two atoms / three base rounds the displayed unit price to zero atoms.
    expect(quoted.venues[0]!.quoteAmount).toBe('0.000000000000000005');
    expect(quoted.route.legs[0]).toMatchObject({ qty: '3', quoteAmount: '0.000000000000000002', effectivePrice: '0' });
    expect(quoted.route.totalQuoteAmount).toBe('0.000000000000000002');
  });

  it('retains the existing integer fee rounding on tiny bought base', async () => {
    const dust = '0.000000000000000003';
    const venue = new FakeVenue({
      id: 'tiny-buy',
      asks: [level('1', dust)],
      feeBps: 5000,
      settlementCost: amt('0.000000000000000001'),
    });
    const quoted = await sourceQuote(deps([venue]), { ...buyOne, qty: amt(dust) });

    // Three gross base atoms minus one fee atom; four quote atoms paid / two received = 2.
    expect(quoted.route.legs[0]).toMatchObject({ qty: dust, quoteAmount: '0.000000000000000004', effectivePrice: '2' });
    expect(quoted.route).toMatchObject({ filledQty: dust, unfilledQty: '0', totalQuoteAmount: '0.000000000000000004' });
  });

  it('reports a partial fill as partial instead of pretending the venue can take it', async () => {
    const venue = new FakeVenue({ id: 'thin', asks: [level('100', '0.4')] });

    const quoted = await sourceQuote(deps([venue]), buyOne);

    expect(quoted.route.filledQty).toBe('0.4');
    expect(quoted.route.unfilledQty).toBe('0.6');
  });

  it('routes to the better EFFECTIVE price, not the better headline', async () => {
    // Both quote 100. The pool charges 30bps and gas; the book charges nothing.
    const book = new FakeVenue({ id: 'book', asks: [level('100', '5')], feeBps: 0 });
    const pool = new FakeVenue({ id: 'pool', kind: 'amm', asks: [level('100', '5')], feeBps: 30, settlementCost: amt('2') });

    const quoted = await sourceQuote(deps([pool, book]), buyOne);

    expect(quoted.route.legs[0]!.venue).toBe('book');
    expect(quoted.venues.find((v) => v.venueId === 'pool')!.kind).toBe('pool');
  });

  it('does not favour our own book — an internal venue wins only on price', async () => {
    // The property `LiquiditySource`'s header protects: no notion of ours vs
    // theirs. venue-adapter's own router has a bounded internal preference;
    // svc-dex's path has none, and this is what would catch one appearing.
    const ours = new FakeVenue({ id: 'internal-book', kind: 'internal', asks: [level('101', '5')] });
    const theirs = new FakeVenue({ id: 'intachain-clob', kind: 'external-dex', asks: [level('100', '5')] });

    const quoted = await sourceQuote(deps([ours, theirs]), buyOne);

    expect(quoted.route.legs[0]!.venue).toBe('intachain-clob');
  });
});

// ── A stale quote is refused ─────────────────────────────────────────────────

describe('QUOTE_MAX_AGE_MS is enforced, not decorative', () => {
  it('refuses when the only book is older than the ceiling', async () => {
    const venue = new FakeVenue({ id: 'v', asks: [level('100', '5')], ageMs: 2_001 });

    const err = await refusal(sourceQuote(deps([venue], 2_000), buyOne));

    expect(err.code).toBe('dex.quote.stale');
    expect(err.venues[0]).toMatchObject({ venueId: 'v', reason: 'stale' });
    expect(err.venues[0]!.detail).toContain('2001ms old');
  });

  it('accepts a book exactly at the ceiling and refuses the next millisecond', async () => {
    const onTime = new FakeVenue({ id: 'v', asks: [level('100', '5')], ageMs: 2_000 });
    const late = new FakeVenue({ id: 'v', asks: [level('100', '5')], ageMs: 2_001 });

    await expect(sourceQuote(deps([onTime], 2_000), buyOne)).resolves.toBeDefined();
    expect((await refusal(sourceQuote(deps([late], 2_000), buyOne))).code).toBe('dex.quote.stale');
  });

  it('drops the stale venue and quotes the fresh one — and says the stale one was dropped', async () => {
    const stale = new FakeVenue({ id: 'stale', asks: [level('90', '5')], ageMs: 9_000 });
    const fresh = new FakeVenue({ id: 'fresh', asks: [level('100', '5')], ageMs: 50 });

    const quoted = await sourceQuote(deps([stale, fresh]), buyOne);

    // The stale venue had the BETTER price. Routing to it would have looked like
    // a win right up to the fill.
    expect(quoted.route.legs.map((l) => l.venue)).toEqual(['fresh']);
    expect(quoted.unavailable).toEqual([expect.objectContaining({ venueId: 'stale', reason: 'stale' })]);
    expect(quoted.degraded).toBe(true);
    expect(quoted.singleVenue).toBe(true);
  });

  it('refuses a book dated in the future rather than treating it as very fresh', async () => {
    const skewed = new FakeVenue({ id: 'v', asks: [level('100', '5')], ageMs: -5_000 });

    const err = await refusal(sourceQuote(deps([skewed]), buyOne));

    expect(err.code).toBe('dex.quote.stale');
    expect(err.venues[0]).toMatchObject({ reason: 'clock_skew' });
  });
});

// ── An unavailable venue is refused, never guessed ───────────────────────────

describe('an unreachable venue produces a refusal, never a guess', () => {
  it('refuses when no venue answers', async () => {
    const down = new FakeVenue({ id: 'a', fails: new VenueUnavailableError('a', 'unreachable', 'a unreachable: ECONNREFUSED') });
    const notReady = new FakeVenue({ id: 'b', fails: new VenueUnavailableError('b', 'not_ready', 'b has projected no chain state') });

    const err = await refusal(sourceQuote(deps([down, notReady]), buyOne));

    expect(err.code).toBe('dex.quote.no_venue_available');
    expect(err.venues.map((v) => v.reason)).toEqual(['unreachable', 'not_ready']);
  });

  it('classifies an unexpected throw as unreachable rather than crashing the quote', async () => {
    const weird = new FakeVenue({ id: 'weird', fails: new Error('kaboom') });

    const err = await refusal(sourceQuote(deps([weird]), buyOne));

    expect(err.code).toBe('dex.quote.no_venue_available');
    expect(err.venues[0]).toMatchObject({ venueId: 'weird', reason: 'unreachable' });
  });

  it('quotes the venues that ARE up, and refuses to call one survivor a best-of-three', async () => {
    // The quiet failure mode of every cross-venue router: two time out and the
    // third's price is presented as best execution across three venues.
    const down = new FakeVenue({ id: 'down', fails: new VenueUnavailableError('down', 'unreachable', 'down unreachable') });
    const alsoDown = new FakeVenue({ id: 'also', fails: new VenueUnavailableError('also', 'unreachable', 'also unreachable') });
    const up = new FakeVenue({ id: 'up', asks: [level('100', '5')] });

    const quoted = await sourceQuote(deps([down, alsoDown, up]), buyOne);

    expect(quoted.route.legs.map((l) => l.venue)).toEqual(['up']);
    expect(quoted.venuesConfigured).toBe(3);
    expect(quoted.venues).toHaveLength(1);
    expect(quoted.unavailable).toHaveLength(2);
    expect(quoted.degraded).toBe(true);
    expect(quoted.singleVenue).toBe(true);
    expect(quoted.bestEx).toEqual({ ok: true, claimed: false });
  });

  it('does not call a single CONFIGURED venue a degraded one', async () => {
    const only = new FakeVenue({ id: 'only', asks: [level('100', '5')] });

    const quoted = await sourceQuote(deps([only]), buyOne);

    expect(quoted.degraded).toBe(false);
    expect(quoted.singleVenue).toBe(false);
  });

  it('refuses rather than answering when nothing is wired at all', async () => {
    const err = await refusal(sourceQuote(deps([]), buyOne));
    expect(err.code).toBe('dex.quote.no_venue_configured');
  });
});

// ── An empty book is a market fact, not an outage ────────────────────────────

describe('no liquidity is reported as no liquidity', () => {
  it('refuses with no_liquidity when every fresh book is empty on the side asked for', async () => {
    // Bids exist, asks do not. A buyer has nobody to buy from — and a route of
    // zero quantity at zero cost reads like a free trade.
    const venue = new FakeVenue({ id: 'v', bids: [level('99', '5')], asks: [] });

    const err = await refusal(sourceQuote(deps([venue]), buyOne));

    expect(err.code).toBe('dex.quote.no_liquidity');
    expect(err.venues[0]).toMatchObject({ reason: 'no_depth' });
  });

  it('prefers no_liquidity over stale when one venue was fresh-but-empty', async () => {
    // The operator answer differs: an empty book is the market, a stale one is us.
    const empty = new FakeVenue({ id: 'empty', asks: [] });
    const stale = new FakeVenue({ id: 'stale', asks: [level('100', '5')], ageMs: 30_000 });

    const err = await refusal(sourceQuote(deps([empty, stale]), buyOne));
    expect(err.code).toBe('dex.quote.no_liquidity');
  });
});

// ── Disclosure ───────────────────────────────────────────────────────────────

describe('what the caller is told about where the price came from', () => {
  it('flags our own engine as custodial, because a fill there is not self-custody', async () => {
    // A permissionless caller may be QUOTED the internal book. They cannot
    // execute against it without verification, so we say so.
    const internal = new FakeVenue({ id: 'internal-book', kind: 'internal', asks: [level('100', '5')] });

    const quoted = await sourceQuote(deps([internal]), buyOne);

    expect(quoted.custodialLegs).toBe(true);
    expect(quoted.venues[0]).toMatchObject({ venueId: 'internal-book', plane: 'fiat', custodial: true, venueKind: 'internal' });
    expect(quoted.internalBook).toEqual({
      enabled: true,
      priced: true,
      custodial: true,
      plane: 'fiat',
      venueKind: 'internal',
      amm: false,
    });
    expect(quoted.ammVenueWired).toBe(false);
    expect(quoted.externalVenueWired).toBe(false);
    expect(quoted.executable).toBe(false);
  });

  it('flags an external CEX as custodial and external — the user needs an account there', async () => {
    const cex = new FakeVenue({ id: 'venue-a', kind: 'external-cex', asks: [level('100', '5')] });

    const quoted = await sourceQuote(deps([cex]), buyOne);

    expect(quoted.venues[0]).toMatchObject({ plane: 'external', custodial: true, venueKind: 'external-cex' });
    expect(quoted.custodialLegs).toBe(true);
    expect(quoted.externalVenueWired).toBe(true);
    expect(quoted.bestEx).toEqual({ ok: true, claimed: false });
  });

  it('is not custodial when only an on-chain venue won a leg', async () => {
    const chain = new FakeVenue({ id: 'intachain-clob', kind: 'external-dex', asks: [level('100', '5')] });
    const internal = new FakeVenue({ id: 'internal-book', kind: 'internal', asks: [level('200', '5')] });

    const quoted = await sourceQuote(deps([chain, internal]), buyOne);

    expect(quoted.route.legs.map((l) => l.venue)).toEqual(['intachain-clob']);
    expect(quoted.custodialLegs).toBe(false);
    // Still disclosed as considered — the caller can see it was ranked and lost.
    expect(quoted.venues.map((v) => v.venueId)).toEqual(['intachain-clob', 'internal-book']);
  });

  it('discloses the fee and settlement cost it applied, because both are configured rather than sourced', async () => {
    const pool = new FakeVenue({ id: 'pool', kind: 'amm', asks: [level('100', '5')], feeBps: 30, settlementCost: amt('1.5') });

    const quoted = await sourceQuote(deps([pool]), buyOne);

    expect(quoted.venues[0]).toMatchObject({ feeBps: 30, settlementCost: '1.5' });
  });

  it('reports money as decimal strings throughout — never a number', async () => {
    const venue = new FakeVenue({ id: 'v', asks: [level('0.000000000000000001', '1')] });

    const quoted = await sourceQuote(deps([venue]), buyOne);

    expect(quoted.route.totalQuoteAmount).toBe('0.000000000000000001');
    expect(typeof quoted.route.legs[0]!.effectivePrice).toBe('string');
  });
});

// ── The §27 adapter contract ─────────────────────────────────────────────────

describe('these adapters are market-data only, and say so', () => {
  it('declares quote and orderbook — never submit or cancel', async () => {
    const venue = new FakeVenue({ id: 'v' });
    expect(venue.capabilities).toEqual(['quote', 'orderbook']);
    expect(venue.capabilities).not.toContain('submit');
  });

  it('REFUSES to submit, loudly, rather than pretending to route an order', async () => {
    // A stub returning `status: 'rejected'` would look like a venue declining a
    // trade. This has to look like what it is: there is no execution path here.
    const venue = new FakeVenue({ id: 'v' });

    await expect(venue.submit()).rejects.toBeInstanceOf(VenueExecutionRefused);
    await expect(venue.submit()).rejects.toThrow(/never executes/);
  });

  it('is not routable before it has ever answered — a source cannot vouch for itself', async () => {
    const venue = new FakeVenue({ id: 'v', asks: [level('100', '1')] });

    expect(isRoutable(venue, NOW)).toBe(false);
    expect(venue.health()).toMatchObject({ healthy: false, reason: 'no successful read yet' });
  });

  it('becomes healthy after a successful read and unhealthy again after a failure', async () => {
    const flaky = { fail: false };
    const venue = new FakeVenue({
      id: 'v',
      asks: [level('100', '1')],
      onFetch: () => {
        if (flaky.fail) throw new VenueUnavailableError('v', 'unreachable', 'gone');
      },
    });

    await venue.depth('IFC-USD', 10);
    expect(venue.health().healthy).toBe(true);

    flaky.fail = true;
    await expect(venue.depth('IFC-USD', 10)).rejects.toThrow();
    expect(venue.health().healthy).toBe(false);
  });

  it('serves the CCXT-shaped order book with decimal strings, never floats', async () => {
    const venue = new FakeVenue({ id: 'v', asks: [level('100.5', '2')], bids: [level('99.5', '3')] });

    const book = await venue.orderBook('IFC-USD', 10);

    expect(book.asks).toEqual([['100.5', '2']]);
    expect(book.bids).toEqual([['99.5', '3']]);
    expect(typeof book.asks[0]![0]).toBe('string');
  });

  it('publishes no market metadata rather than inventing precision and limits', async () => {
    expect(await new FakeVenue({ id: 'v' }).markets()).toEqual([]);
  });
});

describe('outage, unknown, missing finality, and reorg are not fills', () => {
  it('marks a quote kind=quote and never executable-as-fill', async () => {
    const venue = new FakeVenue({ id: 'intachain-clob', asks: [level('100', '2')] });
    const quoted = await sourceQuote(deps([venue]), buyOne);
    expect(quoted.route.kind).toBe('quote');
    expect(quoted.executable).toBe(true);
    expect(quoted.route.executable).toBe(true);
  });

  it('refuses a protocol book with unknown finality rather than routing it', async () => {
    const venue = new FakeVenue({ id: 'intachain-clob', asks: [level('100', '5')], chainFinality: 'unknown' });
    const err = await refusal(sourceQuote(deps([venue]), buyOne));
    expect(err.code).toBe('dex.quote.missing_finality');
    expect(err.venues[0]).toMatchObject({ reason: 'missing_finality' });
  });

  it('refuses an unclassifiable quote as unknown, not as a successful route', async () => {
    const venue = new FakeVenue({
      id: 'odd',
      fails: new VenueUnavailableError('odd', 'unknown', 'cannot classify this payload as a quote'),
    });
    const err = await refusal(sourceQuote(deps([venue]), buyOne));
    expect(err.code).toBe('dex.quote.unknown');
    expect(err.venues[0]).toMatchObject({ reason: 'unknown' });
  });

  it('refuses a reorg-unconfirmed protocol book rather than calling it a fill', async () => {
    const venue = new FakeVenue({ id: 'intachain-clob', asks: [level('100', '5')], chainFinality: 'unconfirmed' });
    const err = await refusal(sourceQuote(deps([venue]), buyOne));
    expect(err.code).toBe('dex.quote.reorg_unconfirmed');
    expect(err.venues[0]).toMatchObject({ reason: 'reorg_unconfirmed' });
  });

  it('drops the unconfirmed venue and will not treat the survivor of an outage as executable', async () => {
    const down = new FakeVenue({ id: 'down', fails: new VenueUnavailableError('down', 'unreachable', 'down unreachable') });
    const up = new FakeVenue({ id: 'up', asks: [level('100', '5')] });

    const quoted = await sourceQuote(deps([down, up]), buyOne);

    expect(quoted.route.legs.map((l) => l.venue)).toEqual(['up']);
    expect(quoted.degraded).toBe(true);
    expect(quoted.executable).toBe(false);
    expect(quoted.route.executable).toBe(false);
    expect(quoted.nonExecutableReason).toBe('degraded');
    expect(quoted.route.kind).toBe('quote');
  });

  it('keeps an internal-book quote visible but not executable — custodial settlement', async () => {
    const internal = new FakeVenue({ id: 'internal-book', kind: 'internal', asks: [level('100', '5')] });
    const quoted = await sourceQuote(deps([internal]), buyOne);
    expect(quoted.route.filledQty).toBe('1');
    expect(quoted.executable).toBe(false);
    expect(quoted.nonExecutableReason).toBe('custodial_settlement');
    expect(quoted.comparableSettlement).toBe(true);
  });

  it('will not call mixed custody/settlement one executable route', async () => {
    const internal = new FakeVenue({
      id: 'internal-book',
      kind: 'internal',
      asks: [level('100', '1')],
    });
    const chain = new FakeVenue({
      id: 'intachain-clob',
      kind: 'external-dex',
      asks: [level('101', '5')],
    });

    const quoted = await sourceQuote(deps([internal, chain]), { ...buyOne, qty: amt('2') });

    expect(quoted.route.legs.map((l) => l.venue)).toEqual(['internal-book', 'intachain-clob']);
    expect(quoted.comparableSettlement).toBe(false);
    expect(quoted.executable).toBe(false);
    expect(quoted.nonExecutableReason).toBe('incomparable_settlement');
  });
});

describe('input guards', () => {
  it('refuses a non-positive quantity before touching a venue', async () => {
    let called = false;
    const venue = new FakeVenue({ id: 'v', onFetch: () => void (called = true) });

    await expect(sourceQuote(deps([venue]), { ...buyOne, qty: 0n })).rejects.toThrow(/must be positive/);
    expect(called).toBe(false);
  });
});
