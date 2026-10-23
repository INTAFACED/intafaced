/**
 * THE STALENESS GATES, AND WHETHER ANYTHING CAN ACTUALLY REACH THEM.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT WAS WRONG
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `mark-policy.ts` states the rule its own gates depend on: *"`asOf` is when the
 * quote was OBSERVED, not when it was read. A source that stamps read-time
 * defeats every staleness check below."*
 *
 * `markSourceFromBook` stamped `args.at` — the CALLER's clock — on every quote,
 * unless given a `now` override that **neither production caller supplied**.
 * `markSourceFromDepth` omits it and `markSourceFromVenuePublicBook` omitted it.
 * So every mark in production had age exactly zero, and `maxAgeSeconds: 300` and
 * `liquidationMaxAgeSeconds: 60` were unreachable by construction: a book from
 * 1970 read at a caller clock of 2030 cleared a sixty-second gate.
 *
 * `venueBookIsGatedOnItsOwnObservationTime` below is that reproduction, kept and
 * inverted. Before the fix its `asOf` was the caller's `at`; now it is the
 * venue's, and the four-hour-old book is refused.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TWO HALVES ARE DIFFERENT, AND ONLY ONE WAS A DEFECT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * THE VENUE HALF WAS UNAMBIGUOUS. `VenueBookSnapshot.observedAt` already exists
 * and is already required by the contract; `markSourceFromVenuePublicBook` read
 * `snap.bids` / `snap.asks` and threw it away. The truthful value was there and
 * was being discarded. Fixed.
 *
 * THE MATCHING-DEPTH HALF IS NOT A DEFECT AND IS DELIBERATELY UNCHANGED — see
 * `readTimeIsTheHonestAnswerForOurOwnBook` at the bottom, which asserts the
 * decision so that reversing it has to be deliberate rather than accidental.
 * `EngineDepth` carries `bids`, `asks` and `sequence` and NO timestamp. There is
 * no observation time to carry, so the only two options were read-time or an
 * invented one — and an invented `observedAt` is strictly worse than an honest
 * read-time one, because it would put a fabricated number in front of a gate
 * whose entire job is to trust that number.
 *
 * The counter-argument is real and is recorded rather than dismissed: a book
 * that has not moved in an hour is not the same thing as a book quoted an hour
 * ago, and `EngineDepth.sequence` is exactly the handle that could tell them
 * apart. But an unchanged sequence means "nobody traded or re-quoted", which is
 * a LIQUIDITY fact, not an age one — and the size floor
 * (`DEFAULT_MIN_BEST_LEVEL_NOTIONAL`) is already the control for "there is not
 * enough resting here to price against". Turning a sequence into a synthetic
 * age would need svc-matching to report when the book last changed, which is a
 * matching-engine change, not a mark change.
 */
import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client/money';
import type { VenueBookSnapshot } from '@intafaced/venue-contracts';
import { markSourceFromBook } from './mark-source.js';
import { markSourceFromDepth } from './mark-from-depth.js';
import { markSourceFromVenuePublicBook, markSourcePrefer } from './mark-from-venue.js';
import type { EngineDepth } from '../spot/matching-client.js';
import { DEFAULT_FUTURES_MARK_POLICY, acceptableForLiquidation, acceptableForMarking } from './mark-policy.js';

/** The caller's clock on every read below. Fixed so ages are exact, not raced. */
const AT = new Date('2030-01-01T00:00:00.000Z');
const seconds = (n: number) => n * 1_000;
const agoBy = (ms: number) => new Date(AT.getTime() - ms);

/** A venue book with a REAL two-sided top and an explicit observation time. */
function venueBook(observedAt: unknown, over?: { bids?: [string, string][]; asks?: [string, string][] }): VenueBookSnapshot {
  const level = ([p, q]: [string, string]) => [parseAmount(p), parseAmount(q)] as const;
  return {
    venueId: 'binance-spot',
    symbol: 'BTC/USDT',
    bids: (over?.bids ?? [['99000', '1']]).map(level),
    asks: (over?.asks ?? [['101000', '1']]).map(level),
    sequence: 1,
    sequenced: true,
    observedAt: observedAt as Date,
  };
}

function venueSource(snapshot: VenueBookSnapshot | (() => VenueBookSnapshot)) {
  return markSourceFromVenuePublicBook({
    adapter: { snapshotBook: async () => (typeof snapshot === 'function' ? snapshot() : snapshot) },
    resolveSymbol: () => 'BTC/USDT',
  });
}

// ════════════════════════════════════════════════════════════════════════════
// THE VENUE PATH — the defect, and the counter-test
// ════════════════════════════════════════════════════════════════════════════

describe('the venue mark carries the venue book’s own observation time', () => {
  /**
   * THE REPRODUCTION, INVERTED.
   *
   * Before the fix this same book produced `asOf === at`, age zero, and
   * `acceptableForLiquidation` returned `ok: true` on a book read four hours
   * earlier. Both assertions below were the opposite and both passed.
   *
   * REVERT-PROOF: delete `observedAt` from the object `readBook` returns in
   * `mark-from-venue.ts` and this test fails on the `asOf` assertion first.
   */
  it('a four-hour-old book is REFUSED — it used to clear a sixty-second gate', async () => {
    const src = venueSource(venueBook(agoBy(4 * 60 * 60 * 1000)));

    const q = await src.quote({ marketId: 'm1', at: AT });
    expect(q).not.toBeNull();
    // The stamp is the VENUE's, not the caller's. This is the whole fix.
    expect(q!.asOf.getTime()).toBe(AT.getTime() - 4 * 60 * 60 * 1000);
    expect(q!.asOf.getTime()).not.toBe(AT.getTime());

    // Four hours is past BOTH limits, so the weaker one refuses first and the
    // stated reason is the 300s one — the liquidation limit is exercised on its
    // own by the two-minute case below.
    const liq = acceptableForLiquidation(q!, null, AT, DEFAULT_FUTURES_MARK_POLICY);
    expect(liq.ok).toBe(false);
    expect(liq.code).toBe('trade.mark_unusable');
    expect(liq.reason).toContain('mark is 14400s old, limit 300s');
    expect(acceptableForMarking(q!, AT, DEFAULT_FUTURES_MARK_POLICY).ok).toBe(false);

    // `markPrice` runs the liquidation gate itself, so the string port refuses too.
    expect(await src.markPrice({ marketId: 'm1', at: AT })).toBeNull();
  });

  /**
   * THE COUNTER-TEST. A gate that refuses everything is as useless as one that
   * refuses nothing. A book observed a second ago is a perfectly good mark and
   * must still price a close.
   *
   * REVERT-PROOF: this is the assertion that fails if the fix over-corrects —
   * e.g. by refusing whenever `observedAt` is present, or by comparing against
   * the wrong end of the interval.
   */
  it('a book observed one second ago still passes both gates and still prices', async () => {
    const src = venueSource(venueBook(agoBy(seconds(1))));

    const q = await src.quote({ marketId: 'm1', at: AT });
    expect(q!.quality).toBe('mid');
    expect(acceptableForMarking(q!, AT, DEFAULT_FUTURES_MARK_POLICY).ok).toBe(true);
    expect(acceptableForLiquidation(q!, null, AT, DEFAULT_FUTURES_MARK_POLICY).ok).toBe(true);
    expect(await src.markPrice({ marketId: 'm1', at: AT })).toBe('100000');
  });

  /**
   * BOTH LIMITS ARE SEPARATELY REACHABLE, which is the point of there being two.
   * `prices.ts`'s asymmetry: a margin-call notice may use a slightly stale mark,
   * a seizure may not. At two minutes old the book is inside `maxAgeSeconds: 300`
   * and outside `liquidationMaxAgeSeconds: 60`, so it may VALUE and may not CLOSE.
   *
   * REVERT-PROOF: this is the test that goes red if someone "fixes" a failure by
   * widening either limit — the two numbers have to stay 60 and 300 apart for
   * both branches here to hold.
   */
  it('at two minutes old it may value a position but may not liquidate one', async () => {
    const src = venueSource(venueBook(agoBy(seconds(120))));
    const q = await src.quote({ marketId: 'm1', at: AT });

    expect(acceptableForMarking(q!, AT, DEFAULT_FUTURES_MARK_POLICY).ok).toBe(true);
    const liq = acceptableForLiquidation(q!, null, AT, DEFAULT_FUTURES_MARK_POLICY);
    expect(liq.ok).toBe(false);
    // The tighter limit is the one that fires, by name.
    expect(liq.reason).toContain('liquidation limit 60s');
    expect(await src.markPrice({ marketId: 'm1', at: AT })).toBeNull();
  });

  /**
   * A BROKEN ADAPTER MUST NOT FALL BACK TO OUR CLOCK.
   *
   * The contract makes `observedAt` required, so absent means the adapter broke
   * it. Substituting the caller's clock there would re-enter the exact bug being
   * removed through the error path — the book would be un-ageable and would
   * clear every gate. `null` is the only honest answer.
   *
   * REVERT-PROOF: replace `if (observedAt == null) return null;` with a fallback
   * to `new Date()` in `mark-from-venue.ts` and both cases below fail.
   */
  it('a snapshot with no observedAt is refused, not stamped with ours', async () => {
    const src = venueSource(venueBook(undefined));
    expect(await src.quote({ marketId: 'm1', at: AT })).toBeNull();
    expect(await src.markPrice({ marketId: 'm1', at: AT })).toBeNull();
  });

  /**
   * THE `NaN` HOLE, WHICH FAILS OPEN RATHER THAN CLOSED.
   *
   * An `Invalid Date` makes `now - asOf` be `NaN`, and `NaN > 300` is `false` —
   * so every staleness comparison in `mark-policy.ts` PASSES on a corrupt stamp.
   * It has to be caught where the stamp is read, not where it is compared.
   */
  it('an Invalid Date observedAt is refused — NaN passes every age comparison', async () => {
    expect(await venueSource(venueBook(new Date('not-a-date'))).quote({ marketId: 'm1', at: AT })).toBeNull();
    // A number where a Date belongs — a hand-rolled adapter's most likely slip.
    expect(await venueSource(venueBook(AT.getTime())).quote({ marketId: 'm1', at: AT })).toBeNull();
  });

  /**
   * REFUSING IS NOT AN OUTAGE — AND MAKING THAT STAY TRUE NEEDED A SECOND FIX.
   *
   * `futures-jobs.ts` wires the venue source ahead of matching depth through
   * `markSourcePrefer`, and this file's header promises a refused venue mid
   * simply falls through to our own book. Carrying `observedAt` broke that
   * promise for the first time: a stale book is a NON-NULL quote, and
   * `markSourcePrefer.quote()` fell through on null alone — so the stale venue
   * quote won the preference, was refused downstream, and the position was
   * skipped while a perfectly healthy matching book sat right behind it.
   *
   * REVERT-PROOF: restore `if (first != null) return first;` in
   * `markSourcePrefer` and this test fails on the `asOf`/`quote` assertions
   * (`markPrice` alone would NOT have caught it — that path already fell
   * through correctly, which is exactly why the hole was easy to miss).
   */
  it('a stale venue book falls through to matching depth rather than going dark', async () => {
    const depth: EngineDepth & { observedAt: Date } = {
      bids: [['1999', '10']],
      asks: [['2001', '10']],
      sequence: 7,
      observedAt: AT,
    };
    const src = markSourcePrefer(
      venueSource(venueBook(agoBy(4 * 60 * 60 * 1000))),
      markSourceFromDepth(async () => depth),
    );

    expect(await src.markPrice({ marketId: 'm1', at: AT })).toBe('2000');
    const q = await src.quote!({ marketId: 'm1', at: AT });
    // The DEPTH quote, carrying the observation time on the book — not the venue's four-hour-old one.
    expect(q!.asOf.getTime()).toBe(AT.getTime());
    expect(acceptableForLiquidation(q!, null, AT, DEFAULT_FUTURES_MARK_POLICY).ok).toBe(true);
  });

  /**
   * THE BAR FOR PREFERENCE IS THE WEAKER GATE, ON PURPose — `markSourcePrefer`
   * does not know whether its caller is drawing a screen or seizing collateral.
   * A two-minute-old venue book is a legitimate VALUATION mark, so it still
   * wins, and the liquidation tick's own gate is what refuses it for a seizure.
   * Falling through here instead would silently reprice every screen off a
   * different book the moment the venue drifted past sixty seconds.
   */
  it('a venue book that clears marking but not liquidation still wins the preference', async () => {
    const depth: EngineDepth & { observedAt: Date } = {
      bids: [['1999', '10']],
      asks: [['2001', '10']],
      sequence: 7,
      observedAt: AT,
    };
    const src = markSourcePrefer(
      venueSource(venueBook(agoBy(seconds(120)))),
      markSourceFromDepth(async () => depth),
    );

    const q = await src.quote!({ marketId: 'm1', at: AT });
    expect(q!.asOf.getTime()).toBe(AT.getTime() - seconds(120));
    expect(acceptableForMarking(q!, AT, DEFAULT_FUTURES_MARK_POLICY).ok).toBe(true);
    expect(acceptableForLiquidation(q!, null, AT, DEFAULT_FUTURES_MARK_POLICY).ok).toBe(false);
    // …and the string port, which runs the liquidation gate, falls through.
    expect(await src.markPrice({ marketId: 'm1', at: AT })).toBe('2000');
  });

  /**
   * WHEN BOTH ARE UNUSABLE, THE REASON SURVIVES. Handing back the primary's
   * refusable quote rather than `null` is what lets the liquidation tick report
   * `skipped_mark_unusable` with "mark is 14400s old" instead of a bare
   * `skipped_no_mark`, which would say nothing about a venue that had stopped.
   */
  it('both sources unusable → the primary’s quote survives so the refusal can say why', async () => {
    const empty: EngineDepth = { bids: [], asks: [], sequence: 1 };
    const src = markSourcePrefer(
      venueSource(venueBook(agoBy(4 * 60 * 60 * 1000))),
      markSourceFromDepth(async () => empty),
    );

    const q = await src.quote!({ marketId: 'm1', at: AT });
    expect(q).not.toBeNull();
    expect(acceptableForLiquidation(q!, null, AT, DEFAULT_FUTURES_MARK_POLICY).reason).toContain('14400s old');
    expect(await src.markPrice({ marketId: 'm1', at: AT })).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// THE PORT ITSELF
// ════════════════════════════════════════════════════════════════════════════

describe('markSourceFromBook precedence: the book’s stamp beats every clock', () => {
  /**
   * A reader that KNOWS when it observed the book wins over an injected `now`.
   * `now` is a construction-time clock; `observedAt` is a per-read fact, and a
   * fact beats a default.
   */
  it('observedAt outranks the injected now() override', async () => {
    const src = markSourceFromBook({
      readBook: async () => ({ bestBid: '100', bestAsk: '102', last: null, observedAt: agoBy(seconds(90)) }),
      now: () => AT,
    });
    const q = await src.quote({ marketId: 'm1', at: AT });
    expect(q!.asOf.getTime()).toBe(AT.getTime() - seconds(90));
    expect(acceptableForLiquidation(q!, null, AT, DEFAULT_FUTURES_MARK_POLICY).ok).toBe(false);
  });

  it('a reader with no stamp of its own gets no quote — the injected clock is not stored', async () => {
    const src = markSourceFromBook({
      readBook: async () => ({ bestBid: '100', bestAsk: '102', last: null }),
      now: () => agoBy(seconds(90)),
    });
    expect(await src.quote({ marketId: 'm1', at: AT })).toBeNull();
  });

  it('a reader that hands back an unusable stamp gets no quote at all', async () => {
    const src = markSourceFromBook({
      readBook: async () => ({ bestBid: '100', bestAsk: '102', last: null, observedAt: new Date(Number.NaN) }),
    });
    expect(await src.quote({ marketId: 'm1', at: AT })).toBeNull();
  });

  /** The stamp is carried on the `last`-quality branch too, not only the mid one. */
  it('a one-sided book’s `last` quote carries the stamp as well', async () => {
    const src = markSourceFromBook({
      readBook: async () => ({ bestBid: null, bestAsk: null, last: '77', observedAt: agoBy(seconds(200)) }),
    });
    const q = await src.quote({ marketId: 'm1', at: AT });
    expect(q!.quality).toBe('last');
    expect(q!.asOf.getTime()).toBe(AT.getTime() - seconds(200));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// THE HALF THAT IS DELIBERATELY UNCHANGED
// ════════════════════════════════════════════════════════════════════════════

describe('matching depth without an observation time is not a quote', () => {
  /**
   * ASSERTING A DECISION, NOT A BEHAVIOUR WE ARE PROUD OF.
   *
   * `EngineDepth` has no timestamp — `bids`, `asks`, `sequence` and nothing
   * else — so the read genuinely IS the observation for our own book, and there
   * is no truthful alternative value to put here. This test exists so that
   * anyone who later gives depth a real observation time has to come and delete
   * it, rather than discovering the question was never asked.
   *
   * If svc-matching ever reports when the book last changed, this is the test to
   * change, and `readBook` in `mark-from-depth.ts` gains an `observedAt` — the
   * port already accepts one, so no other file moves.
   */
  it('a depth book with no observedAt yields no quote', async () => {
    const depth: EngineDepth = { bids: [['1999', '10']], asks: [['2001', '10']], sequence: 1 };
    const q = await markSourceFromDepth(async () => depth).quote({ marketId: 'm1', at: AT });
    expect(q).toBeNull();
  });

  /**
   * AND THE HONEST LIMIT OF THAT, STATED. An unchanged `sequence` means nobody
   * has traded or re-quoted, and this path cannot tell that from a fresh book —
   * both mark at read time. That is a liquidity question, which the size floor
   * answers, not an age one.
   */
  it('an hour of no sequence movement is not stamped fresh by the caller clock', async () => {
    let depth: EngineDepth = { bids: [['1999', '10']], asks: [['2001', '10']], sequence: 42 };
    const src = markSourceFromDepth(async () => depth);
    const first = await src.quote({ marketId: 'm1', at: agoBy(seconds(3600)) });
    depth = { ...depth };
    const later = await src.quote({ marketId: 'm1', at: AT });

    expect(first).toBeNull();
    expect(later).toBeNull();
  });
});
