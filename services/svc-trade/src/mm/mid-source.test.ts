import { describe, expect, it, vi } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client/money';
import type { VenueBookSnapshot } from '@intafaced/venue-contracts';
import { chainMmMidSources, createConfigMmMidSource, createMmMidSourceFromConfig, createVenueMmMidSource } from './mid-source.js';
import { AcceptedMmMid } from './accepted-mid.js';

const priceOf = (mid: AcceptedMmMid | null): string | null => mid?.price ?? null;

/**
 * A venue snapshot AS THE CONTRACT DEFINES IT — `observedAt` included.
 *
 * Every double in this file used to omit that field, and that is how the discard
 * it hides survived here: a double that drops a required field cannot fail when
 * the code under test drops it too. `observedAt` is not optional in
 * `VenueBookSnapshot`, so a double without one describes an adapter that cannot
 * exist, and a test built on it proves nothing about the real path.
 *
 * Quantities are deliberately well clear of `DEFAULT_MIN_BEST_LEVEL_NOTIONAL`
 * rather than sitting exactly on it, so a test about symbol resolution or source
 * chaining does not quietly double as a test of the floor's boundary.
 */
const NOW = new Date('2026-08-08T12:00:00.000Z');
const readNow = () => NOW;

function venueBook(input: {
  bid?: readonly [string, string] | null;
  ask?: readonly [string, string] | null;
  observedAt?: Date;
}): VenueBookSnapshot {
  const side = (l: readonly [string, string] | null | undefined) =>
    l ? ([[parseAmount(l[0]), parseAmount(l[1])]] as [bigint, bigint][]) : ([] as [bigint, bigint][]);
  return {
    venueId: 'test-venue',
    symbol: 'BTC/USDT',
    bids: side(input.bid),
    asks: side(input.ask),
    sequence: 1,
    sequenced: true,
    observedAt: input.observedAt ?? new Date(NOW.getTime() - 1_000),
  };
}

/**
 * A snapshot with NO `observedAt` — which the contract makes impossible and a
 * real adapter can produce anyway.
 *
 * The cast is the point rather than a convenience. `VenueBookSnapshot.observedAt`
 * is required, so this shape cannot be written without one; but the adapters are
 * JavaScript at runtime reading somebody else's JSON, and "the field is required"
 * has never once stopped a field from being absent. The branch under test exists
 * for exactly that, and a test that could not construct the case would leave the
 * branch permanently unexercised.
 */
function unstampedBook(input: { bid: readonly [string, string]; ask: readonly [string, string] }): VenueBookSnapshot {
  const { observedAt: _dropped, ...rest } = venueBook(input);
  return rest as unknown as VenueBookSnapshot;
}

/** Real size on both sides, read a second ago. The book a mid SHOULD come from. */
const healthyBook = () => venueBook({ bid: ['100', '5'], ask: ['102', '5'] });

describe('createConfigMmMidSource', () => {
  it('returns mapped mid; never invents missing', async () => {
    const src = createConfigMmMidSource(new Map([['m1', '100.5']]));
    expect(priceOf(await src('m1'))).toBe('100.5');
    expect(await src('missing')).toBeNull();
  });

  it('treats blank mid as null', () => {
    const src = createConfigMmMidSource(new Map([['m1', '  ']]));
    expect(src('m1')).toBeNull();
  });
});

describe('createVenueMmMidSource', () => {
  it('mids two-sided book; null when unmapped or empty', async () => {
    const adapter = { snapshotBook: vi.fn(async () => healthyBook()) };

    const src = createVenueMmMidSource({
      adapter,
      resolveSymbol: (id) => (id === 'm1' ? 'BTC/USDT' : null),
      now: readNow,
    });
    const mid = await src('m1');
    expect(mid).not.toBeNull();
    expect(priceOf(mid)).toBe('101');

    expect(await src('no-map')).toBeNull();

    adapter.snapshotBook.mockResolvedValueOnce(venueBook({}));
    expect(await src('m1')).toBeNull();
  });

  it('null on venue error — never invent', async () => {
    const src = createVenueMmMidSource({
      adapter: {
        snapshotBook: vi.fn(async () => {
          throw new Error('down');
        }),
      },
      resolveSymbol: () => 'BTC/USDT',
    });
    expect(await src('m1')).toBeNull();
  });

  /**
   * THE THIRD SIZE-BLIND MID, REPRODUCED.
   *
   * Before the fix these four assertions all failed: a book worth femto-cents, a
   * book four hours old, a book with one dust side and a snapshot with no
   * `observedAt` at all each produced a perfectly confident mid, which
   * `seed-jobs.ts` would have posted with no gate anywhere after it.
   */
  describe('a book nobody checked is not a price', () => {
    const midFor = (snapshot: VenueBookSnapshot) =>
      createVenueMmMidSource({
        adapter: { snapshotBook: vi.fn(async () => snapshot) },
        resolveSymbol: () => 'BTC/USDT',
        now: readNow,
      })('m1');

    it('refuses a dust book — two 1-wei orders do not mint a seed mid', async () => {
      // ~1e-15 quote units a side, against a floor of 100. Refused by fifteen
      // orders of magnitude, not by a hair.
      const dust = venueBook({ bid: ['1000', '0.000000000000000001'], ask: ['3000', '0.000000000000000001'] });
      expect(await midFor(dust)).toBeNull();
    });

    it('refuses when only ONE side is dust — a one-sided book has one honest answer', async () => {
      const halfDust = venueBook({ bid: ['100', '5'], ask: ['102', '0.000000000000000001'] });
      expect(await midFor(halfDust)).toBeNull();
    });

    it('refuses a stale book — a four-hour-old snapshot is a memory, not a quote', async () => {
      const stale = venueBook({
        bid: ['100', '5'],
        ask: ['102', '5'],
        observedAt: new Date(NOW.getTime() - 4 * 60 * 60 * 1_000),
      });
      expect(await midFor(stale)).toBeNull();
    });

    it('refuses a snapshot with no observedAt — never substitutes our clock', async () => {
      expect(await midFor(unstampedBook({ bid: ['100', '5'], ask: ['102', '5'] }))).toBeNull();
    });

    it('refuses a book stamped in the future — a clock problem is how staleness passes', async () => {
      const future = venueBook({
        bid: ['100', '5'],
        ask: ['102', '5'],
        observedAt: new Date(NOW.getTime() + 10 * 60 * 1_000),
      });
      expect(await midFor(future)).toBeNull();
    });

    /**
     * THE COUNTER-TEST. A gate that refuses everything is as useless as one that
     * refuses nothing, and this repo has shipped both. Deep, fresh, two-sided:
     * the mid must still arrive, and must still be the mid.
     */
    it('a deep, fresh book still yields its mid', async () => {
      const deep = venueBook({ bid: ['30000', '2'], ask: ['30010', '2'], observedAt: new Date(NOW.getTime() - 5_000) });
      expect(priceOf(await midFor(deep))).toBe('30005');
    });

    it('a book just inside the age limit still yields its mid', async () => {
      // 299s against DEFAULT_FUTURES_MARK_POLICY.maxAgeSeconds = 300.
      const nearlyStale = venueBook({ bid: ['100', '5'], ask: ['102', '5'], observedAt: new Date(NOW.getTime() - 299_000) });
      expect(await midFor(nearlyStale)).not.toBeNull();
    });
  });

  it('honours an injected notional floor without a second constant', async () => {
    // Same policy SHAPE as the futures paths, so an owner ruling lands in one
    // place. A book worth 500 a side passes the default and fails a 10_000 floor.
    const adapter = { snapshotBook: vi.fn(async () => healthyBook()) };
    const strict = createVenueMmMidSource({
      adapter,
      resolveSymbol: () => 'BTC/USDT',
      depthPolicy: { minBestLevelNotional: '10000' },
      now: readNow,
    });
    expect(await strict('m1')).toBeNull();
  });
});

describe('chainMmMidSources', () => {
  it('prefers first non-null', async () => {
    const chain = chainMmMidSources(
      () => null,
      () => AcceptedMmMid.configured('50'),
      () => AcceptedMmMid.configured('99'),
    );
    expect(priceOf(await chain('x'))).toBe('50');
  });

  it('all null → null', async () => {
    const chain = chainMmMidSources(
      () => null,
      async () => null,
    );
    expect(await chain('x')).toBeNull();
  });
});

describe('createMmMidSourceFromConfig', () => {
  it('config only when midFromVenue off', async () => {
    const src = createMmMidSourceFromConfig({
      midsEnv: 'm1:42',
      midFromVenue: false,
      venueAdapter: {
        snapshotBook: vi.fn(async () => {
          throw new Error('should not call');
        }),
      },
      resolveVenueSymbol: () => 'BTC/USDT',
    });
    expect(priceOf(await src('m1'))).toBe('42');
    expect(await src('m2')).toBeNull();
  });

  it('falls through to venue when config missing and midFromVenue on', async () => {
    const src = createMmMidSourceFromConfig({
      midsEnv: '',
      midFromVenue: true,
      venueAdapter: { snapshotBook: vi.fn(async () => venueBook({ bid: ['200', '5'], ask: ['200', '5'] })) },
      resolveVenueSymbol: (id) => (id === 'm1' ? 'BTC/USDT' : null),
      now: readNow,
    });
    expect(await src('m1')).not.toBeNull();
    expect(await src('m2')).toBeNull();
  });

  it('config beats venue', async () => {
    const src = createMmMidSourceFromConfig({
      midsEnv: 'm1:10',
      midFromVenue: true,
      venueAdapter: { snapshotBook: vi.fn(async () => venueBook({ bid: ['999', '5'], ask: ['999', '5'] })) },
      resolveVenueSymbol: () => 'BTC/USDT',
      now: readNow,
    });
    expect(priceOf(await src('m1'))).toBe('10');
  });

  it('null venue adapter with midFromVenue → config only', async () => {
    const src = createMmMidSourceFromConfig({
      midsEnv: '',
      midFromVenue: true,
      venueAdapter: null,
      resolveVenueSymbol: () => 'BTC/USDT',
    });
    expect(await src('m1')).toBeNull();
  });

  /**
   * THE OPS MAP IS NOT GATED, DELIBERATELY, AND THAT IS NOT A HOLE HERE.
   *
   * `TRADE_MM_SEED_MIDS` is a human typing a number, not a book being copied.
   * There is no size and no age to check because there is no book — the gates
   * added to the venue source are about an unchecked EXTERNAL book, and applying
   * them to an ops-injected price would refuse every value an operator can
   * supply. Stated as a test so the asymmetry is a decision on the record rather
   * than something a later reader mistakes for the same defect left half-fixed.
   */
  it('leaves the ops mid map ungated — a typed price has no book to check', async () => {
    const src = createMmMidSourceFromConfig({
      midsEnv: 'm1:0.000000000000000001',
      midFromVenue: false,
      venueAdapter: null,
      resolveVenueSymbol: () => null,
    });
    expect(priceOf(await src('m1'))).toBe('0.000000000000000001');
  });
});

describe('createVenueMmMidSource from MaintainedBook port', () => {
  const twoSided = {
    bestBid: parseAmount('100'),
    bestAsk: parseAmount('102'),
    bestBidQty: parseAmount('5'),
    bestAskQty: parseAmount('5'),
    spread: parseAmount('2'),
    mid: parseAmount('101'),
  };
  const observedAt = new Date(NOW.getTime() - 1_000);

  it('mids a servable sequenced top and does not poll snapshotBook', async () => {
    const snapshotBook = vi.fn(async () => healthyBook());
    const src = createVenueMmMidSource({
      adapter: { snapshotBook },
      resolveSymbol: () => 'BTC/USDT',
      now: readNow,
      bookForSymbol: () => ({
        servable: true,
        top: () => twoSided,
        observedAt: () => observedAt,
      }),
    });
    expect(await src('m1')).not.toBeNull();
    expect(snapshotBook).not.toHaveBeenCalled();
  });

  it('withholds while the feed is desynced — never invents a seed mid from a gap', async () => {
    const src = createVenueMmMidSource({
      adapter: { snapshotBook: vi.fn(async () => healthyBook()) },
      resolveSymbol: () => 'BTC/USDT',
      now: readNow,
      bookForSymbol: () => ({
        servable: false,
        top: () => twoSided,
        observedAt: () => observedAt,
      }),
    });
    expect(await src('m1')).toBeNull();
  });

  /**
   * An Invalid Date is not null. `getTime()` is NaN, `toQuotedMark` keeps that
   * stamp, and `acceptableForMarking` treats NaN age as inside the window
   * (`NaN > maxAgeSeconds` is false). The snapshot path already refuses this
   * through `readObservedAt`. A finite stamp on the same book still mids.
   */
  it('refuses an Invalid Date observedAt and still mids a finite one', async () => {
    const maintained = (at: Date) =>
      createVenueMmMidSource({
        adapter: { snapshotBook: vi.fn(async () => healthyBook()) },
        resolveSymbol: () => 'BTC/USDT',
        now: readNow,
        bookForSymbol: () => ({
          servable: true,
          top: () => twoSided,
          observedAt: () => at,
        }),
      });

    expect(await maintained(new Date(Number.NaN))('m1')).toBeNull();

    const finite = await maintained(observedAt)('m1');
    expect(finite).not.toBeNull();
    expect(priceOf(finite)).toBe('101');
    expect(finite?.provenance).toBe('venue');
  });
});
