/**
 * MM seed mid port (A-TRADE-MM-3).
 *
 * Mids are always **external**:
 *   1. Config map (`TRADE_MM_SEED_MIDS`) — ops-injected prices
 *   2. Optional venue public book mid (when enabled) — fabric snapshot, never invent
 *
 * Null at every layer → seed job skips the market (seed-jobs already refuses empty mid).
 * Never synthesizes a price from thin air.
 *
 * "NEVER INVENT" WAS TRUE AND WAS NOT ENOUGH. The venue mid below was faithfully
 * copied from a real external book — and copied a book's dust and a book's age
 * along with its price, because it read only the price at each best level. A
 * price you did not make up but also did not check is not a checked price. See
 * `createVenueMmMidSource` for the chain that made that matter and for the two
 * gates it now runs, both borrowed from the futures mark path rather than
 * reinvented here.
 */
import type { MarketDataAdapter } from '@intafaced/venue-contracts';
import { depthRequirement, type DepthQuotePolicy } from '../futures/mark-from-depth.js';
import { midFromVenueBook, readObservedAt, type MaintainedVenueBookPort } from '../futures/mark-from-venue.js';
import { DEFAULT_FUTURES_MARK_POLICY, acceptableForMarking, type MarkPolicy } from '../futures/mark-policy.js';
import { toQuotedMark } from '../futures/mark-source.js';
import { AcceptedMmMid } from './accepted-mid.js';
import { parseMmSeedMids } from './seed-jobs.js';

export type MmMidSource = (marketId: string) => AcceptedMmMid | null | Promise<AcceptedMmMid | null>;

/** Static ops map only. */
export function createConfigMmMidSource(mids: ReadonlyMap<string, string>): MmMidSource {
  return (marketId) => {
    const mid = mids.get(marketId);
    if (mid == null || mid.trim() === '') return null;
    return AcceptedMmMid.configured(mid);
  };
}

/**
 * Mid from venue public book (top bid/ask). Missing symbol / empty book / error → null.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * THIS MID WAS THE THIRD SIZE-BLIND ONE, AND THE ONLY ONE WITH NO GATE AFTER IT
 * ───────────────────────────────────────────────────────────────────────────────
 *
 * This function read `snap.bids[0][0]` and `snap.asks[0][0]` — the PRICE at each
 * best level — and discarded `[1]`, the QUANTITY, and `snap.observedAt` with it.
 * It is the same pair of discards already fixed in `futures/mark-from-depth.ts`
 * (`bestFromDepth`, size, c7dfb5e4), `futures/mark-from-venue.ts`
 * (`bestFromVenueBook`, size, cc90c2f4) and again on that file for age (#1163).
 *
 * WHAT MADE THIS COPY THE WORST OF THE THREE. Both fixed paths hand their mid to
 * a `QuotedMarkSource`, so a bad answer still met `mark-policy.ts` downstream.
 * `MmMidSource` originally returned a bare `string | null`. `mm/seed-jobs.ts`
 * checked it for null and blank and nothing else; `mm/seed-market.ts` handed it
 * to `planSeedQuotes`, which validated the DECIMAL and never asked where it came
 * from. The port now returns `AcceptedMmMid`: configured inputs are explicitly
 * sealed at their boundary and venue inputs are sealed only after the existing
 * futures size and age policies accept them.
 *
 * ── HOW A BOOK THE FUTURES PATH REFUSED CAME BACK AS OUR OWN PRICE ────────────
 *
 * `index.ts` builds this source from `venuePublicAdapter` and
 * `parseVenueMarkSymbols(env.TRADE_VENUE_MARK_SYMBOLS)` — the SAME adapter
 * instance and the SAME symbol map that `createConfiguredVenueMarkSource` reads
 * for futures marks. So the two paths read one external book through one mapping,
 * and the interesting case is the one where they disagree:
 *
 *   1. the venue's book goes to dust, or stops updating, on a mapped symbol;
 *   2. the futures venue mark REFUSES it — that is exactly what cc90c2f4 and
 *      #1163 built — and `markSourcePrefer` falls through to matching depth;
 *   3. matching depth is OUR book, and this MM seeded that book off the very
 *      snapshot step 2 refused;
 *   4. `bestFromDepth`'s size requirement then measures the MM's OWN
 *      `TRADE_MM_SEED_QTY`, which is ops-chosen, and `markSourceFromDepth` stamps
 *      the depth read as the observation — so the age is zero by construction no
 *      matter how old the venue book was.
 *
 * The dust and the staleness are laundered: refused as somebody else's quote,
 * accepted as ours. Step 4 is not a hole in `bestFromDepth` — every requirement it
 * carries, the absolute floor and the size-relative one added after an absolute
 * floor was measured paying out 190,000 USDT, asks a question about SIZE: is there
 * enough resting here to stand behind this payout. On our own seeded book there
 * is. None of them can ask about PROVENANCE — "was this price copied from a book
 * nobody checked" — because by then the venue snapshot is gone and only its number
 * survives. Only this function still has the snapshot, which is why the check is
 * here and not there. A stronger size rule downstream does not substitute for it,
 * and would not have caught this.
 *
 * HONEST ABOUT THE ONE LINK THAT NEEDS OPS. Step 3 requires
 * `TRADE_MM_SEED_MARKETS` to name a market whose depth futures marks read.
 * `seed-market.ts` submits straight to `matching.submit` and never passes
 * `assertTradable`, so nothing in code stops that; it is a configuration away,
 * not an exploit, and seeding a freshly-listed market is the feature's purpose.
 * The chain is therefore reachable-by-configuration rather than live on today's
 * defaults, and it is stated that way rather than overclaimed.
 *
 * ── THE LAW, WHICH LANDED THE DAY THIS WAS WRITTEN ────────────────────────────
 *
 * `docs/adr/2026-08-08-house-desk-and-market-making-fairness.md` rule 1,
 * Accepted: *"Internal quotes may seed liquidity. They may never become a mark."*
 * Its own safety argument is that *"if the internal MM is the only resting size,
 * the book is not payout-grade and the mark refuses — exactly as it does today
 * for a dust book."* That argument holds on SIZE and says nothing about
 * PROVENANCE: an MM resting genuine size at a price copied from a dust or stale
 * external book produces a payout-grade book carrying an unchecked price. Rule 1
 * gets broken without anyone deciding to break it. Refusing here is what keeps
 * the rule true.
 *
 * ── WHAT IS REUSED, AND NOTHING IS INVENTED ───────────────────────────────────
 *
 * `midFromVenueBook` is imported from `mark-from-venue.ts`, which is where the
 * size-aware mid over this exact snapshot shape already lives; through it this
 * path gets `bestLevelIsQuotable` and `DEFAULT_MIN_BEST_LEVEL_NOTIONAL` from
 * `mark-from-depth.ts`. The requirement is built with that file's own
 * `depthRequirement`, so when its two halves changed shape under this branch this
 * path had one call to adapt and no rule to re-decide — which is the whole point
 * of importing it. `readObservedAt` comes from `mark-from-venue.ts` too. The age
 * bar is `acceptableForMarking` under `DEFAULT_FUTURES_MARK_POLICY`.
 *
 * There is NO new constant, no new policy shape and no new name here on purpose:
 * `DEFAULT_MIN_BEST_LEVEL_NOTIONAL` is the D26-P0-14 sealed floor, and a second
 * number would be a third % the ADR forbids.
 *
 * `acceptableForMarking` is the WEAKER of the two gates, for the reason
 * `markSourcePrefer` gives: this port does not know its caller's bar, so it must
 * not apply one. If the owner wants the 60-second liquidation bar on seed mids,
 * `policy` already carries it and no call site moves.
 *
 * REFUSING IS RETURNING NULL, which this function already did for a missing
 * symbol and an empty book, and which `seed-jobs.ts` already handles by skipping
 * the market (`skipped: 'missing_mid'`). No new refusal vocabulary, no new
 * branch downstream, and nothing anywhere turns a null mid into a number — the
 * one honest answer was already in this function's vocabulary.
 */
export function createVenueMmMidSource(input: {
  adapter: Pick<MarketDataAdapter, 'snapshotBook'>;
  /** marketId → venue unified symbol. Missing → null mid. */
  resolveSymbol: (marketId: string) => string | null;
  /**
   * When set, mids come from the sequenced MaintainedBook (same port as futures
   * marks). Unset keeps snapshotBook poll. Desynced / missing or non-finite observedAt → null.
   */
  bookForSymbol?: (symbol: string) => MaintainedVenueBookPort | null;
  depthLimit?: number;
  /**
   * Minimum resting notional at a best level. Omitted → D26-P0-14 sealed pair
   * in `mark-from-depth.ts`. Unsafe reading must not be the one you get by
   * leaving an argument off.
   */
  depthPolicy?: DepthQuotePolicy;
  /** Staleness bar for the snapshot. Omitted → `DEFAULT_FUTURES_MARK_POLICY`. */
  policy?: MarkPolicy;
  /**
   * Reading clock, injectable for tests. Our clock is legitimate as *now*; it was
   * only ever wrong as `observedAt`, which is what this function used to imply.
   */
  now?: () => Date;
}): MmMidSource {
  const limit = input.depthLimit ?? 5;
  const policy = input.policy ?? DEFAULT_FUTURES_MARK_POLICY;
  const readNow = input.now ?? (() => new Date());
  /**
   * `authorisedSize: null` — "the read authorises nothing", the same reading
   * `mark-from-depth.ts` gives a public quote or a ladder depth measurement.
   *
   * IT IS THE HONEST ANSWER HERE AND NOT A WAY ROUND THE RELATIVE HALF. The
   * relative requirement asks whether a best level carries enough of the
   * POSITION whose payout this mid would authorise. This mid authorises no
   * payout on any position: it prices a quote we are about to POST, and there is
   * no size in scope to take a percentage of. Passing a size would mean naming
   * one, and the only size available — `TRADE_MM_SEED_QTY` — is our own order,
   * not anybody's exposure; measuring the venue's book against our order size
   * would be a number with no meaning attached.
   *
   * The ABSOLUTE floor still applies in full, which is exactly the case its own
   * doc comment keeps it for: "what catches the femto-cent book when NO position
   * is in scope." The relative requirement stays where it belongs — on the close
   * path, against a size read under a row lock.
   */
  const requirement = input.depthPolicy ? depthRequirement(null, input.depthPolicy) : depthRequirement(null);
  return async (marketId) => {
    const symbol = input.resolveSymbol(marketId);
    if (symbol == null || symbol.trim() === '') return null;
    try {
      if (input.bookForSymbol) {
        const book = input.bookForSymbol(symbol);
        if (book == null || !book.servable) return null;
        const observedAt = book.observedAt();
        // Invalid Date is not null. getTime() is NaN, toQuotedMark keeps it, and
        // acceptableForMarking treats NaN age as inside the window. Same refusal
        // as readObservedAt on the snapshot path: a non-finite stamp is no stamp.
        if (observedAt == null || !Number.isFinite(observedAt.getTime())) return null;
        const top = book.top();
        if (top == null) return null;
        const mid = midFromVenueBook(
          {
            bids: top.bestBid != null && top.bestBidQty != null ? [[top.bestBid, top.bestBidQty]] : [],
            asks: top.bestAsk != null && top.bestAskQty != null ? [[top.bestAsk, top.bestAskQty]] : [],
          },
          requirement,
        );
        if (mid == null) return null;
        const quote = toQuotedMark({ marketId, symbol, price: mid, quality: 'mid', asOfMs: observedAt.getTime() });
        if (quote == null) return null;
        if (!acceptableForMarking(quote, readNow(), policy).ok) return null;
        return AcceptedMmMid.venue(mid);
      }

      const snap = await input.adapter.snapshotBook(symbol, limit);

      // A snapshot that cannot say when it was read cannot be aged, and an
      // unageable price on a path with no downstream gate is a price with no
      // age limit at all. `observedAt` is required by the contract, so this
      // branch is a broken adapter — refuse, never substitute our clock.
      //
      // NOT REVERT-PROOF ON ITS OWN, and said here rather than left for someone
      // to discover: deleting just this one line breaks no assertion in
      // `mid-source.test.ts`. `observedAt.getTime()` below would throw on null
      // and the blanket `catch` would turn that into the same `null`, so the test
      // stays green while the refusal has become an accident. The line stays
      // because a caught TypeError is not a decision — and reverting the
      // observedAt handling as a WHOLE (this read plus the gate below, i.e. the
      // original defect) does turn three tests red.
      const observedAt = readObservedAt(snap);
      if (observedAt == null) return null;

      // Size gate lives in `midFromVenueBook`: a best level too thin to trade
      // against is read as ABSENT, one absent side makes the book one-sided, and
      // a one-sided book already had exactly one honest answer here.
      const mid = midFromVenueBook(snap, requirement);
      if (mid == null) return null;

      // Age gate through the existing mark vocabulary rather than a second one.
      const quote = toQuotedMark({ marketId, symbol, price: mid, quality: 'mid', asOfMs: observedAt.getTime() });
      if (quote == null) return null;
      if (!acceptableForMarking(quote, readNow(), policy).ok) return null;

      return AcceptedMmMid.venue(mid);
    } catch {
      return null;
    }
  };
}

/**
 * First non-null mid wins. All null → null (never invent).
 */
export function chainMmMidSources(...sources: readonly MmMidSource[]): MmMidSource {
  return async (marketId) => {
    for (const src of sources) {
      const mid = await src(marketId);
      if (mid != null) return mid;
    }
    return null;
  };
}

/**
 * Build the production mid chain from ops config.
 *
 * - Always: env mid map (may be empty)
 * - Optional: venue mid when `midFromVenue` and adapter present
 */
export function createMmMidSourceFromConfig(input: {
  /** Raw `marketId:mid,...` */
  midsEnv: string;
  midFromVenue: boolean;
  venueAdapter: Pick<MarketDataAdapter, 'snapshotBook'> | null;
  /** marketId → venue symbol when midFromVenue */
  resolveVenueSymbol: (marketId: string) => string | null;
  bookForSymbol?: (symbol: string) => MaintainedVenueBookPort | null;
  /**
   * Both optional and both defaulting inside `createVenueMmMidSource`. They exist
   * so the day the owner rules a different notional floor or a stricter seed-mid
   * staleness bar, the answer lands here and `index.ts` does not move.
   */
  depthPolicy?: DepthQuotePolicy;
  policy?: MarkPolicy;
  now?: () => Date;
}): MmMidSource {
  const config = createConfigMmMidSource(parseMmSeedMids(input.midsEnv));
  if (!input.midFromVenue || input.venueAdapter == null) {
    return config;
  }
  const venue = createVenueMmMidSource({
    adapter: input.venueAdapter,
    resolveSymbol: input.resolveVenueSymbol,
    ...(input.bookForSymbol ? { bookForSymbol: input.bookForSymbol } : {}),
    ...(input.depthPolicy ? { depthPolicy: input.depthPolicy } : {}),
    ...(input.policy ? { policy: input.policy } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
  return chainMmMidSources(config, venue);
}

// ci: retrigger
