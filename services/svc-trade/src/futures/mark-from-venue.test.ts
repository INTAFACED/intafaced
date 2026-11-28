import { describe, expect, it, vi } from 'vitest';
import { parseAmount, formatAmount } from '@intafaced/ledger-client/money';
import type { MarketDataAdapter, VenueBookSnapshot } from '@intafaced/venue-contracts';
import type { HttpPort } from '@intafaced/venue-adapter';
import {
  bestFromVenueBook,
  createConfiguredVenueMarkSource,
  createVenueMarketDataAdapter,
  markSourceFromVenuePublicBook,
  markSourceFromMaintainedVenueBook,
  markSourcePrefer,
  midFromVenueBook,
  parseVenueMarkSymbols,
} from './mark-from-venue.js';
import { DEFAULT_MIN_BEST_LEVEL_NOTIONAL, depthRequirement } from './mark-from-depth.js';
import type { MarkSource } from './liquidation-tick.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** One wei. The smallest order the ledger's 18-decimal scale can express. */
const DUST = '0.000000000000000001';

/** `[price, quantity]` decimal strings → the scaled-bigint pair the fabric hands over. */
const lvl = (p: string, q: string) => [parseAmount(p), parseAmount(q)] as const;

/**
 * A book the adapter JUST READ — which is what every case in this file means by
 * "a venue book". They are all about size, mapping and transport, not age.
 *
 * `observedAt` used to be a hard-coded `1_700_000_000_000` (November 2023), and
 * it did not matter, because `markSourceFromVenuePublicBook` discarded the field
 * and stamped the CALLER's clock instead. Now that a venue mark carries the
 * book's real observation time, a fixed past stamp is a three-year-old book, and
 * five assertions below correctly stopped believing it. Defaulting to "now" is
 * what these tests always meant. Age is varied deliberately, and only, in
 * `mark-observed-at.test.ts`.
 */
function snap(partial: {
  bids?: [string, string][];
  asks?: [string, string][];
  venueId?: string;
  symbol?: string;
  observedAt?: Date;
}): VenueBookSnapshot {
  const level = ([p, q]: [string, string]) => [parseAmount(p), parseAmount(q)] as const;
  return {
    venueId: partial.venueId ?? 'binance-spot',
    symbol: partial.symbol ?? 'BTC/USDT',
    bids: (partial.bids ?? []).map(level),
    asks: (partial.asks ?? []).map(level),
    sequence: 1,
    sequenced: true,
    observedAt: partial.observedAt ?? new Date(),
  };
}

function fakeAdapter(impl: MarketDataAdapter['snapshotBook']): Pick<MarketDataAdapter, 'snapshotBook'> {
  return { snapshotBook: impl };
}

describe('midFromVenueBook', () => {
  it('mids two-sided top of book', () => {
    expect(midFromVenueBook({ bids: [lvl('100', '10')], asks: [lvl('102', '10')] }, depthRequirement(null))).toBe('101');
  });

  it('empty or one-sided → null (never invent)', () => {
    expect(midFromVenueBook({ bids: [], asks: [] }, depthRequirement(null))).toBeNull();
    expect(midFromVenueBook({ bids: [lvl('100', '10')], asks: [] }, depthRequirement(null))).toBeNull();
  });

  /**
   * THE DEFECT, AT THE LEVEL IT LIVED AT.
   *
   * This function read index 0 of each level — the price — and discarded index
   * 1, the quantity, so one wei resting at 1000 and one wei resting at 3000 on
   * an EXTERNAL venue read as a perfectly ordinary two-sided book and minted a
   * payout-grade mid of 2000.
   */
  it('a best level carrying dust is not a level (it used to answer 2000)', () => {
    expect(midFromVenueBook({ bids: [lvl('1000', DUST)], asks: [lvl('3000', DUST)] }, depthRequirement(null))).toBeNull();
  });

  it('reads the QUANTITY, not just the price — same prices, different sizes, different answer', () => {
    expect(midFromVenueBook({ bids: [lvl('1000', '0.001')], asks: [lvl('3000', '0.001')] }, depthRequirement(null))).toBeNull();
    expect(midFromVenueBook({ bids: [lvl('1000', '1')], asks: [lvl('3000', '1')] }, depthRequirement(null))).toBe('2000');
  });
});

describe('bestFromVenueBook', () => {
  it('reads top of book when the best levels carry real size', () => {
    expect(bestFromVenueBook({ bids: [lvl('99', '10')], asks: [lvl('101', '20')] }, depthRequirement(null))).toEqual({
      bestBid: '99',
      bestAsk: '101',
    });
  });

  it('empty book → null sides', () => {
    expect(bestFromVenueBook({ bids: [], asks: [] }, depthRequirement(null))).toEqual({ bestBid: null, bestAsk: null });
  });

  it('one thin side is enough to make the book one-sided', () => {
    expect(bestFromVenueBook({ bids: [lvl('1000', '10')], asks: [lvl('3000', DUST)] }, depthRequirement(null))).toEqual({
      bestBid: '1000',
      bestAsk: null,
    });
  });

  /**
   * THE SAME NUMBER AS THE MATCHING-BOOK PATH, ON PURPOSE.
   *
   * A second default here would be a second unruled risk parameter, not a
   * second decision. This asserts the two paths cannot drift apart silently.
   */
  it('applies the SHARED threshold by default — omitting the policy does not disable it', () => {
    expect(DEFAULT_MIN_BEST_LEVEL_NOTIONAL).toBe('100');
    // 99.999… quote units a side: one wei under the floor, and refused.
    const justUnder = { bids: [lvl('99.999999999999999999', '1')], asks: [lvl('101', '0.99')] };
    expect(bestFromVenueBook(justUnder, depthRequirement(null))).toEqual({ bestBid: null, bestAsk: null });
    // Exactly the floor is enough — the level is worth the minimum.
    expect(bestFromVenueBook({ bids: [lvl('100', '1')], asks: [lvl('100', '1')] }, depthRequirement(null))).toEqual({
      bestBid: '100',
      bestAsk: '100',
    });
  });

  it('honours a configured threshold in both directions', () => {
    const book = { bids: [lvl('100', '0.5')], asks: [lvl('102', '0.5')] };
    // 50 / 51 quote units a side: under the default 100, over a configured 10.
    expect(bestFromVenueBook(book, depthRequirement(null))).toEqual({ bestBid: null, bestAsk: null });
    expect(bestFromVenueBook(book, depthRequirement(null, { minBestLevelNotional: '10' }))).toEqual({ bestBid: '100', bestAsk: '102' });
    expect(bestFromVenueBook(book, depthRequirement(null, { minBestLevelNotional: '1000' }))).toEqual({ bestBid: null, bestAsk: null });
  });

  it('an unreadable threshold falls back to the default rather than to no check', () => {
    expect(
      bestFromVenueBook(
        { bids: [lvl('1000', DUST)], asks: [lvl('3000', DUST)] },
        depthRequirement(null, { minBestLevelNotional: 'not-a-number' }),
      ),
    ).toEqual({
      bestBid: null,
      bestAsk: null,
    });
  });

  it('a non-positive quantity is no size at all', () => {
    expect(bestFromVenueBook({ bids: [lvl('1000', '0')], asks: [lvl('3000', '99')] }, depthRequirement(null)).bestBid).toBeNull();
  });
});

describe('parseVenueMarkSymbols', () => {
  it('empty → no invent map', () => {
    expect(parseVenueMarkSymbols(undefined).size).toBe(0);
    expect(parseVenueMarkSymbols('').size).toBe(0);
    expect(parseVenueMarkSymbols('  ').size).toBe(0);
  });

  it('parses marketId:symbol pairs', () => {
    const m = parseVenueMarkSymbols('m1:BTC/USDT, m2:ETH/USDT');
    expect(m.get('m1')).toBe('BTC/USDT');
    expect(m.get('m2')).toBe('ETH/USDT');
  });

  it('skips malformed pairs rather than inventing', () => {
    const m = parseVenueMarkSymbols('nocolon, :nosymbol, empty:, good:BTC/USDT');
    expect(m.size).toBe(1);
    expect(m.get('good')).toBe('BTC/USDT');
  });
});

describe('createVenueMarketDataAdapter', () => {
  it('empty / off → null (feature off)', () => {
    expect(createVenueMarketDataAdapter('')).toBeNull();
    expect(createVenueMarketDataAdapter('off')).toBeNull();
    expect(createVenueMarketDataAdapter('none')).toBeNull();
  });

  it('unknown venue → null (refuse invent adapter)', () => {
    expect(createVenueMarketDataAdapter('made-up-cex')).toBeNull();
  });

  it('binance-spot → real public MarketDataAdapter', () => {
    const a = createVenueMarketDataAdapter('binance-spot');
    expect(a).not.toBeNull();
    expect(a!.venue.id).toBe('binance-spot');
  });

  /**
   * THE REGISTRATION, REACHED BY ITS ID.
   *
   * An adapter that exists in `packages/venue-adapter` and is not registered in
   * the fabric factory is a file, not a venue: nothing in production can name it, so no grade, no
   * cross-check and no mark can ever come from it. This assertion is the one that
   * goes red if the `bybit-spot` branch is deleted.
   */
  it('bybit-spot → real public MarketDataAdapter, reached by its id', () => {
    const a = createVenueMarketDataAdapter('bybit-spot');
    expect(a).not.toBeNull();
    expect(a!.venue.id).toBe('bybit-spot');
    expect(a!.venue.kind).toBe('external-cex');
    // Sequenced on BOTH its REST book and its stream — which is why the existing
    // tracker drives it unchanged rather than needing a second book path.
    expect(a!.venue.sequencedDepth).toBe(true);
  });

  it('the two ids resolve to DIFFERENT adapters — grading one venue against itself is not grading', () => {
    const binance = createVenueMarketDataAdapter('binance-spot');
    const bybit = createVenueMarketDataAdapter('bybit-spot');
    expect(binance!.venue.id).not.toBe(bybit!.venue.id);
  });

  it('case and whitespace are tolerated; a near-miss id is still refused', () => {
    expect(createVenueMarketDataAdapter('  BYBIT-SPOT  ')!.venue.id).toBe('bybit-spot');
    // Not a prefix match, not a fuzzy match. A typo must not silently resolve to
    // a venue the operator did not name.
    expect(createVenueMarketDataAdapter('bybit')).toBeNull();
    expect(createVenueMarketDataAdapter('bybit-futures')).toBeNull();
    expect(createVenueMarketDataAdapter('okx')).toBeNull();
    expect(createVenueMarketDataAdapter('okx-futures')).toBeNull();
  });

  it('okx-spot → real public MarketDataAdapter, reached by its id', () => {
    const a = createVenueMarketDataAdapter('okx-spot');
    expect(a).not.toBeNull();
    expect(a!.venue.id).toBe('okx-spot');
    expect(a!.venue.kind).toBe('external-cex');
    expect(a!.venue.sequencedDepth).toBe(true);
    expect(createVenueMarketDataAdapter('  OKX-SPOT  ')!.venue.id).toBe('okx-spot');
  });

  it('the three ids resolve to DIFFERENT adapters — a median of one is not a check', () => {
    const binance = createVenueMarketDataAdapter('binance-spot');
    const bybit = createVenueMarketDataAdapter('bybit-spot');
    const okx = createVenueMarketDataAdapter('okx-spot');
    expect(new Set([binance!.venue.id, bybit!.venue.id, okx!.venue.id]).size).toBe(3);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// THE SECOND VENUE, ON THE MONEY PATH
//
// Not a double: the REAL `BybitSpotMarketData`, built by the REAL ops factory
// from its id, with only the HTTP transport faked — there is no live-network CI
// (§27 residual 4) and adding one is a separate decision. Every case below
// asserts the money path answers `null`, because a refusal that is correct inside
// the adapter and unreachable from here would prove nothing.
// ════════════════════════════════════════════════════════════════════════════

/** A one-shot HTTP port. `null` body / non-200 are DATA to this seam, never throws. */
function fixedHttp(body: unknown, status = 200): HttpPort {
  return {
    async get() {
      return { status, body, header: () => null };
    },
  };
}

const bybitBook = (over: { b?: [string, string][]; a?: [string, string][] }): unknown => ({
  retCode: 0,
  retMsg: 'OK',
  result: { s: 'BTCUSDT', b: over.b ?? [], a: over.a ?? [], ts: 1, u: 42, seq: 42, cts: 1 },
  time: 1,
});

/** The production path: venue id → factory → adapter → mark source. Transport faked only. */
function bybitMarkSource(http: HttpPort) {
  const configured = createConfiguredVenueMarkSource({
    venueId: 'bybit-spot',
    symbols: 'm1:BTC/USDT',
    adapter: createVenueMarketDataAdapter('bybit-spot', { http, restBase: 'https://rest.test' }),
  });
  expect(configured).not.toBeNull();
  return configured!.source;
}

describe('bybit-spot reaches the mark path, and refuses on it', () => {
  /**
   * No `adapter` key at all — the ops factory has to build it from the id alone,
   * which is exactly what `svc-trade`'s startup does with
   * `TRADE_VENUE_MARK_VENUE`. Construction opens no socket and sends no request.
   */
  it('the ops factory builds the venue from its id with nothing injected', () => {
    const configured = createConfiguredVenueMarkSource({ venueId: 'bybit-spot', symbols: 'm1:BTC/USDT' });
    expect(configured).not.toBeNull();
    expect(configured!.venueId).toBe('bybit-spot');
    expect(configured!.symbolCount).toBe(1);
  });

  it('a real two-sided book with real size behind it mids normally', async () => {
    const src = bybitMarkSource(fixedHttp(bybitBook({ b: [['99000', '1']], a: [['101000', '1']] })));
    expect(await src.markPrice({ marketId: 'm1', at: new Date() })).toBe('100000');
  });

  it('EMPTY book → null', async () => {
    const src = bybitMarkSource(fixedHttp(bybitBook({ b: [], a: [] })));
    expect(await src.markPrice({ marketId: 'm1', at: new Date() })).toBeNull();
  });

  it('ONE-SIDED book → null', async () => {
    const src = bybitMarkSource(fixedHttp(bybitBook({ b: [['99000', '1']], a: [] })));
    expect(await src.markPrice({ marketId: 'm1', at: new Date() })).toBeNull();
  });

  it('UNKNOWN market id at the venue (non-zero retCode) → null, never an empty book', async () => {
    const src = bybitMarkSource(fixedHttp({ retCode: 10_001, retMsg: 'Not supported symbols', result: {}, time: 1 }));
    expect(await src.markPrice({ marketId: 'm1', at: new Date() })).toBeNull();
  });

  it('UNMAPPED symbol → null, and the venue is never called', async () => {
    const configured = createConfiguredVenueMarkSource({
      venueId: 'bybit-spot',
      // `m1` is mapped; `m-other` is not.
      symbols: 'm1:BTC/USDT',
      adapter: createVenueMarketDataAdapter('bybit-spot', {
        http: {
          async get() {
            throw new Error('must not call the venue for an unmapped market');
          },
        },
        restBase: 'https://rest.test',
      }),
    });
    expect(await configured!.source.markPrice({ marketId: 'm-other', at: new Date() })).toBeNull();
  });

  it('MALFORMED payload (JSON numbers in the book) → null', async () => {
    const src = bybitMarkSource(
      fixedHttp({ retCode: 0, retMsg: 'OK', result: { s: 'BTCUSDT', b: [[99_000, 1]], a: [[101_000, 1]], ts: 1, u: 1 }, time: 1 }),
    );
    expect(await src.markPrice({ marketId: 'm1', at: new Date() })).toBeNull();
  });

  it('RATE LIMITED (403 access too frequent) → null', async () => {
    const src = bybitMarkSource(fixedHttp({ retCode: 10_018, retMsg: 'access too frequent' }, 403));
    expect(await src.markPrice({ marketId: 'm1', at: new Date() })).toBeNull();
  });

  it('UNREACHABLE venue → null', async () => {
    const src = bybitMarkSource(fixedHttp(null, 503));
    expect(await src.markPrice({ marketId: 'm1', at: new Date() })).toBeNull();
  });

  /**
   * THE SHARED THRESHOLD, ON THE NEW VENUE, WITHOUT ONE LINE OF NEW POLICY.
   *
   * `DEFAULT_MIN_BEST_LEVEL_NOTIONAL` exists because a size-blind mid let two
   * dust orders mint a payout-grade mark. The second venue inherits it because
   * the gate lives in `bestFromVenueBook`, not in any adapter — and this asserts
   * that, so nobody "fixes" the new venue by giving it a threshold of its own.
   */
  it('two dust orders on the NEW venue mint nothing either — same threshold, no second policy', async () => {
    const src = bybitMarkSource(fixedHttp(bybitBook({ b: [['1000', DUST]], a: [['3000', DUST]] })));
    expect(await src.markPrice({ marketId: 'm1', at: new Date() })).toBeNull();
    expect(await src.quote({ marketId: 'm1', at: new Date() })).toBeNull();
    expect(DEFAULT_MIN_BEST_LEVEL_NOTIONAL).toBe('100');
  });
});

const okxBook = (over: { bids?: [string, string][]; asks?: [string, string][]; code?: string }): unknown => ({
  code: over.code ?? '0',
  msg: '',
  data: [
    {
      asks: (over.asks ?? []).map(([p, q]) => [p, q, '0', '1']),
      bids: (over.bids ?? []).map(([p, q]) => [p, q, '0', '1']),
      ts: String(Date.now()),
      seqId: 7,
    },
  ],
});

function okxMarkSource(http: HttpPort) {
  const configured = createConfiguredVenueMarkSource({
    venueId: 'okx-spot',
    symbols: 'm1:BTC/USDT',
    adapter: createVenueMarketDataAdapter('okx-spot', { http, restBase: 'https://rest.test', heartbeatMs: 0 }),
  });
  expect(configured).not.toBeNull();
  return configured!.source;
}

describe('okx-spot reaches the mark path, and refuses on it', () => {
  it('the ops factory builds the venue from its id with nothing injected', () => {
    const configured = createConfiguredVenueMarkSource({ venueId: 'okx-spot', symbols: 'm1:BTC/USDT' });
    expect(configured).not.toBeNull();
    expect(configured!.venueId).toBe('okx-spot');
  });

  it('a real two-sided book with real size behind it mids normally', async () => {
    const src = okxMarkSource(fixedHttp(okxBook({ bids: [['99000', '1']], asks: [['101000', '1']] })));
    expect(await src.markPrice({ marketId: 'm1', at: new Date() })).toBe('100000');
  });

  it('EMPTY book → null', async () => {
    const src = okxMarkSource(fixedHttp(okxBook({ bids: [], asks: [] })));
    expect(await src.markPrice({ marketId: 'm1', at: new Date() })).toBeNull();
  });

  it('ONE-SIDED book → null', async () => {
    const src = okxMarkSource(fixedHttp(okxBook({ bids: [['99000', '1']], asks: [] })));
    expect(await src.markPrice({ marketId: 'm1', at: new Date() })).toBeNull();
  });

  it('UNKNOWN instrument (non-zero code) → null, never an empty book', async () => {
    const src = okxMarkSource(fixedHttp({ code: '51001', msg: 'Instrument ID does not exist', data: [] }));
    expect(await src.markPrice({ marketId: 'm1', at: new Date() })).toBeNull();
  });

  it('UNMAPPED symbol → null, and the venue is never called', async () => {
    const configured = createConfiguredVenueMarkSource({
      venueId: 'okx-spot',
      symbols: 'm1:BTC/USDT',
      adapter: createVenueMarketDataAdapter('okx-spot', {
        http: {
          async get() {
            throw new Error('must not call the venue for an unmapped market');
          },
        },
        restBase: 'https://rest.test',
        heartbeatMs: 0,
      }),
    });
    expect(await configured!.source.markPrice({ marketId: 'm-other', at: new Date() })).toBeNull();
  });

  it('two dust orders mint nothing — same threshold, no second policy', async () => {
    const src = okxMarkSource(fixedHttp(okxBook({ bids: [['1000', DUST]], asks: [['3000', DUST]] })));
    expect(await src.markPrice({ marketId: 'm1', at: new Date() })).toBeNull();
  });
});

describe('markSourceFromVenuePublicBook', () => {
  it('mids venue public snapshot when market is mapped', async () => {
    const adapter = fakeAdapter(async (symbol) => {
      expect(symbol).toBe('BTC/USDT');
      return snap({ bids: [['99000', '1']], asks: [['101000', '1']], symbol });
    });
    const src = markSourceFromVenuePublicBook({
      adapter,
      resolveSymbol: (id) => (id === 'm1' ? 'BTC/USDT' : null),
    });
    expect(await src.markPrice({ marketId: 'm1', at: new Date() })).toBe('100000');
  });

  it('unmapped market → null (never invent symbol)', async () => {
    const adapter = fakeAdapter(async () => {
      throw new Error('must not call venue for unmapped market');
    });
    const src = markSourceFromVenuePublicBook({
      adapter,
      resolveSymbol: () => null,
    });
    expect(await src.markPrice({ marketId: 'unknown', at: new Date() })).toBeNull();
  });

  it('empty venue book → null', async () => {
    const src = markSourceFromVenuePublicBook({
      adapter: fakeAdapter(async () => snap({ bids: [], asks: [] })),
      resolveSymbol: () => 'BTC/USDT',
    });
    expect(await src.markPrice({ marketId: 'm1', at: new Date() })).toBeNull();
  });

  it('venue error → null (never invent mid)', async () => {
    const src = markSourceFromVenuePublicBook({
      adapter: fakeAdapter(async () => {
        throw new Error('rate_limited');
      }),
      resolveSymbol: () => 'BTC/USDT',
    });
    expect(await src.markPrice({ marketId: 'm1', at: new Date() })).toBeNull();
  });

  /**
   * THE DEFECT ON THE MONEY PATH, IN ONE ASSERTION.
   *
   * Before the fix this returned '2000' — a payout-grade `mid`, quality and
   * all, minted from two orders on an EXTERNAL venue worth about four
   * femto-cents between them. `readBook` here had its own copy of the
   * size-blind read, so fixing `midFromVenueBook` alone would have left the
   * money path untouched.
   */
  it('refuses to mint a mid from two dust orders on the venue book', async () => {
    const src = markSourceFromVenuePublicBook({
      adapter: fakeAdapter(async () => snap({ bids: [['1000', DUST]], asks: [['3000', DUST]] })),
      resolveSymbol: () => 'BTC/USDT',
    });
    expect(await src.markPrice({ marketId: 'm1', at: new Date() })).toBeNull();
  });

  /**
   * REFUSES, rather than downgrading to `last`. A downgraded quote still clears
   * `acceptableForMarking`, so it would still reach margin-call arithmetic and
   * a trader's screen as though the venue had quoted it. There is no quote here
   * at all.
   */
  it('a thin venue book yields no quote of any quality — not a downgraded one', async () => {
    const src = markSourceFromVenuePublicBook({
      adapter: fakeAdapter(async () => snap({ bids: [['1000', DUST]], asks: [['3000', DUST]] })),
      resolveSymbol: () => 'BTC/USDT',
    });
    expect(await src.quote({ marketId: 'm1', at: new Date() })).toBeNull();
  });

  it('the same venue book with real size behind it still quotes normally', async () => {
    const src = markSourceFromVenuePublicBook({
      adapter: fakeAdapter(async () => snap({ bids: [['1000', '1']], asks: [['3000', '1']] })),
      resolveSymbol: () => 'BTC/USDT',
    });
    expect(await src.markPrice({ marketId: 'm1', at: new Date() })).toBe('2000');
  });

  /**
   * THE RELATIVE REQUIREMENT REACHES SOMEBODY ELSE'S BOOK TOO.
   *
   * Same venue, same snapshot, same instant — only the position the mark would
   * price differs. A venue mid is not exempt from the rule that a mark must be
   * backed by depth proportional to what it pays out on; if anything the case is
   * stronger, because nothing here is under this platform's control.
   */
  it('refuses a venue mid that is real but thin for the position it would price', async () => {
    const src = markSourceFromVenuePublicBook({
      adapter: fakeAdapter(async () => snap({ bids: [['1000', '1']], asks: [['3000', '1']] })),
      resolveSymbol: () => 'BTC/USDT',
    });
    const at = new Date();
    expect(await src.markPrice({ marketId: 'm1', at, authorisesSize: parseAmount('50') })).toBe('2000');
    expect(await src.markPrice({ marketId: 'm1', at, authorisesSize: parseAmount('500') })).toBeNull();
  });

  it('honours an injected depthPolicy without any call site changing', async () => {
    const book = fakeAdapter(async () => snap({ bids: [['100', '0.5']], asks: [['102', '0.5']] }));
    expect(
      await markSourceFromVenuePublicBook({ adapter: book, resolveSymbol: () => 'BTC/USDT' }).markPrice({ marketId: 'm1', at: new Date() }),
    ).toBeNull();
    expect(
      await markSourceFromVenuePublicBook({
        adapter: book,
        resolveSymbol: () => 'BTC/USDT',
        depthPolicy: { minBestLevelNotional: '10' },
      }).markPrice({ marketId: 'm1', at: new Date() }),
    ).toBe('101');
  });
});

describe('markSourcePrefer', () => {
  it('uses primary when present', async () => {
    const primary: MarkSource = { markPrice: async () => '111' };
    const secondary: MarkSource = { markPrice: async () => '222' };
    const src = markSourcePrefer(primary, secondary);
    expect(await src.markPrice({ marketId: 'm', at: new Date() })).toBe('111');
  });

  it('falls back to secondary when primary null', async () => {
    const primary: MarkSource = { markPrice: async () => null };
    const secondary: MarkSource = { markPrice: async () => '222' };
    const src = markSourcePrefer(primary, secondary);
    expect(await src.markPrice({ marketId: 'm', at: new Date() })).toBe('222');
  });

  it('both null → null', async () => {
    const src = markSourcePrefer({ markPrice: async () => null }, { markPrice: async () => null });
    expect(await src.markPrice({ marketId: 'm', at: new Date() })).toBeNull();
  });
});

describe('createConfiguredVenueMarkSource', () => {
  it('unconfigured venue → null', () => {
    expect(
      createConfiguredVenueMarkSource({
        venueId: '',
        symbols: 'm1:BTC/USDT',
        adapter: fakeAdapter(async () => snap({ bids: [['1', '1']], asks: [['3', '1']] })),
      }),
    ).toBeNull();
  });

  it('configured + injected adapter → honest mid', async () => {
    const cfg = createConfiguredVenueMarkSource({
      venueId: 'binance-spot',
      symbols: 'm1:BTC/USDT',
      // 100 / 120 quote units a side — a real book, not two orders.
      adapter: fakeAdapter(async () => snap({ bids: [['10', '10']], asks: [['12', '10']] })),
    });
    expect(cfg).not.toBeNull();
    expect(cfg!.symbolCount).toBe(1);
    expect(await cfg!.source.markPrice({ marketId: 'm1', at: new Date() })).toBe('11');
    expect(await cfg!.source.markPrice({ marketId: 'unmapped', at: new Date() })).toBeNull();
  });

  /** The production factory is gated too — not just the function under it. */
  it('configured + a DUST venue book → null, through the real ops factory', async () => {
    const cfg = createConfiguredVenueMarkSource({
      venueId: 'binance-spot',
      symbols: 'm1:BTC/USDT',
      adapter: fakeAdapter(async () => snap({ bids: [['1000', DUST]], asks: [['3000', DUST]] })),
    });
    expect(await cfg!.source.markPrice({ marketId: 'm1', at: new Date() })).toBeNull();
  });

  it('carries an owner-set threshold through to the venue book', async () => {
    const cfg = createConfiguredVenueMarkSource({
      venueId: 'binance-spot',
      symbols: 'm1:BTC/USDT',
      adapter: fakeAdapter(async () => snap({ bids: [['10', '1']], asks: [['12', '1']] })),
      depthPolicy: { minBestLevelNotional: '5' },
    });
    expect(await cfg!.source.markPrice({ marketId: 'm1', at: new Date() })).toBe('11');
  });

  it('unknown venue without inject → null', () => {
    expect(
      createConfiguredVenueMarkSource({
        venueId: 'not-a-real-venue',
        symbols: 'm1:BTC/USDT',
      }),
    ).toBeNull();
  });
});

describe('honesty: fabric snapshot is the only data path', () => {
  it('calls snapshotBook once per mark read with mapped symbol', async () => {
    const snapshotBook = vi.fn(async () => snap({ bids: [['50', '10']], asks: [['50', '10']] }));
    const src = markSourceFromVenuePublicBook({
      adapter: { snapshotBook },
      resolveSymbol: () => 'ETH/USDT',
    });
    await src.markPrice({ marketId: 'm-eth', at: new Date() });
    expect(snapshotBook).toHaveBeenCalledTimes(1);
    expect(snapshotBook).toHaveBeenCalledWith('ETH/USDT', 5);
  });
});

describe('markSourceFromMaintainedVenueBook', () => {
  const observedAt = new Date('2026-08-14T05:00:00.000Z');
  const twoSided = {
    bestBid: parseAmount('100'),
    bestAsk: parseAmount('102'),
    bestBidQty: parseAmount('10'),
    bestAskQty: parseAmount('10'),
    spread: parseAmount('2'),
    mid: parseAmount('101'),
  };

  it('mids a servable sequenced top and keeps tracker observedAt', async () => {
    const src = markSourceFromMaintainedVenueBook({
      resolveSymbol: () => 'BTC/USDT',
      bookForSymbol: () => ({
        servable: true,
        top: () => twoSided,
        observedAt: () => observedAt,
      }),
    });
    const q = await src.quote!({ marketId: 'm1', at: new Date('2026-08-14T05:00:01.000Z') });
    expect(q && formatAmount(q.price)).toBe('101');
    expect(q?.asOf).toEqual(observedAt);
    expect(q?.provenance).toBe('venue');
  });

  it('withholds the mark while the feed is desynced — never invents from a gap', async () => {
    const src = markSourceFromMaintainedVenueBook({
      resolveSymbol: () => 'BTC/USDT',
      bookForSymbol: () => ({
        servable: false,
        top: () => twoSided,
        observedAt: () => observedAt,
      }),
    });
    expect(await src.markPrice({ marketId: 'm1', at: new Date() })).toBeNull();
  });

  it('withholds when the tracker has no observedAt — a book without an age is not a mark', async () => {
    const src = markSourceFromMaintainedVenueBook({
      resolveSymbol: () => 'BTC/USDT',
      bookForSymbol: () => ({
        servable: true,
        top: () => twoSided,
        observedAt: () => null,
      }),
    });
    expect(await src.markPrice({ marketId: 'm1', at: new Date() })).toBeNull();
  });

  it('does not poll snapshotBook when createConfigured is given a maintained port', async () => {
    const snapshotBook = vi.fn(async () => snap({ bids: [['50', '10']], asks: [['50', '10']] }));
    const cfg = createConfiguredVenueMarkSource({
      venueId: 'binance-spot',
      symbols: 'm1:BTC/USDT',
      adapter: fakeAdapter(snapshotBook),
      bookForSymbol: () => ({
        servable: true,
        top: () => twoSided,
        observedAt: () => observedAt,
      }),
    });
    expect(await cfg!.source.markPrice({ marketId: 'm1', at: observedAt })).toBe('101');
    expect(snapshotBook).not.toHaveBeenCalled();
  });
});

// Kept source pins: what these read is wired where no test can call it yet, or on paths a behaviour test does not drive.
// Each pin stays until a behaviour test holds the same property on every path.
describe('kept source pins', () => {
  it('boot warn and env comments list okx-spot now that the factory knows it (kept source pin)', () => {
    const root = dirname(fileURLToPath(import.meta.url));
    const indexSrc = readFileSync(join(root, '../index.ts'), 'utf8');
    const envSrc = readFileSync(join(root, '../env.ts'), 'utf8');
    expect(indexSrc).toMatch(/Supported: binance-spot, bybit-spot, okx-spot/);
    expect(envSrc).toMatch(/`binance-spot`, `bybit-spot`, `okx-spot`/);
  });
});
