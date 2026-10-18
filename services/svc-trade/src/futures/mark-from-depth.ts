/**
 * Mark from matching depth (trade.futures residual).
 *
 * Adapts EngineDepth (bids/asks levels) into a QuotedMarkSource via
 * mid-of-book. Empty or one-sided book → null (never invent). Depth carries no
 * last print, so every quote this source produces is `mid` quality.
 *
 * Does not call matching itself; inject depth reader (svc-matching port).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE MID USED TO BE SIZE-BLIND
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `bestFromDepth` read `depth.bids[0]?.[0]` and `depth.asks[0]?.[0]` — the PRICE
 * at each best level — and threw away the QUANTITY at index 1 entirely. So one
 * wei resting at 1000 and one wei resting at 3000 minted a payout-grade `mid` of
 * 2000, and a close priced off it paid real money out of the profit pot. It was
 * measured before it was fixed: 2,000 USDT on a ten-unit long, against a book
 * holding two orders worth about four femto-cents between them
 * (`position-service.test.ts`, "two dust orders mint a payout-grade mark").
 *
 * WHAT USED TO STAND HERE, AND WHY THIS PARAGRAPH CHANGED. Until
 * `feat/futures-orderable-path` this file said the defect "is not exploitable on
 * `main` today only because `assertTradable` refuses non-spot on the order path,
 * so futures books are always empty" — "a different file's accident, not a
 * control" — and named the change that would make it exploitable.
 *
 * That change has landed. `assertTradable` takes a futures order whenever
 * `TRADE_FUTURES_ENABLED` is on, so a futures book now holds whatever anyone rests
 * in it, two dust orders included. The old sentence is rewritten rather than
 * deleted because it is the argument for the check below: this file, and no longer
 * that one, is what stands between a dust book and a payout. Done-bar item 8 of
 * `docs/adr/2026-08-07-futures-exit-when-the-feed-is-dark.md` is why it could not
 * simply be left standing — "a comment that claims a property the code lacks is
 * worse than no comment, and this one cost us the finding."
 *
 * The order path does not quietly become a second line of defence either. A
 * market's `min_notional` refuses an order too small to matter, but it is a
 * per-listing value chosen when the market is created, so it bounds one order and
 * says nothing about the mark. `futures/orderable-path.test.ts` therefore rests its
 * dust through the real order path of a market whose floor permits it, so that the
 * refusal being tested is this one and not a listing parameter standing in for it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SO: A BOOK TOO THIN TO BE WORTH ANYTHING IS NOT A QUOTE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A side whose best level carries less than `minBestLevelNotional` is treated as
 * ABSENT, not as cheap. One side absent makes the book one-sided, and a
 * one-sided book already has exactly one honest answer here: null. The refusal
 * therefore arrives through machinery that already existed — no new error code,
 * no second refusal vocabulary.
 *
 * REFUSING RATHER THAN DEGRADING, deliberately. The two alternatives were:
 *
 *   · label it `last`, which the liquidation gate refuses anyway but the
 *     VALUATION gate accepts — so a dust mid would still reach margin-call
 *     arithmetic and a trader's screen as though someone had quoted it;
 *   · walk past the dust to the first level with real size, which invents a
 *     price nobody is actually resting at the top of the book, and quietly
 *     changes what "best bid" means in a file whose whole job is not inventing.
 *
 * Both hide a book that cannot support a trade. "An illiquid book is exactly
 * where a forced sale does most damage" (`prices.ts`) — and it is also exactly
 * where a payout does. The position sits and an operator looks at it, which is
 * the answer this codebase has already chosen twice for the same shape of
 * problem.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AN ABSOLUTE FLOOR CANNOT GATE AN UNBOUNDED PAYOUT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every paragraph above is still true and all of them together were still
 * insufficient, and the gap was measured: **190,000 USDT out of the profit pot
 * for ten USDT of margin plus about 240 USDT of resting quotes that were
 * refunded in full.** Two orders worth roughly 120 quote units each cleared
 * `DEFAULT_MIN_BEST_LEVEL_NOTIONAL` by twenty percent, and the mid they minted
 * was then used to price the close of a position of ONE MILLION of notional.
 *
 * The defect is not the number. It is that the number is ABSOLUTE while the
 * thing it authorises is not. `bestLevelIsQuotable` was handed a price and a
 * quantity and asked "is this level worth more than 100 units of the quote
 * asset" — a question with no reference to the position whose payout the answer
 * funds. One threshold therefore had to be simultaneously high enough to gate a
 * million-unit position and low enough not to strand a hundred-unit one, and no
 * single number is both. Raising the 100 does not fix it; it moves the size at
 * which the same arithmetic works, and makes ordinary markets unquotable on the
 * way past.
 *
 * ── THE RELATIONSHIP, AND THE ARGUMENT FOR IT ───────────────────────────────
 *
 * **A best level may back a mark that authorises a payout on a position of size
 * S only if that level carries at least `minBestLevelBpsOfNotional` of S.**
 *
 * Stated in BASE units, deliberately rather than for convenience. At the level's
 * own price the two readings are the same statement — `qty >= f*S` is exactly
 * `price*qty >= f*(S*price)`, i.e. the level is worth at least the fraction `f`
 * of the position notional THIS MARK IS MINTING — so nothing is given up, and
 * two bad denominators are avoided. Sizing the requirement off a notional
 * computed at the mark you are deciding whether to trust is not a check, it is a
 * fixed point. Sizing it off the stored entry price instead would rate today's
 * liquidity against a number set when the position opened, which on exactly the
 * market move the breaker exists to catch is the stalest denominator available.
 *
 * WHY A FRACTION IS THE RIGHT SHAPE OF CLAIM. A mark asserts "this position
 * could be closed here". Requiring the whole position to rest at one level would
 * assert something no real venue satisfies — top of book is a fraction of any
 * serious position — and would refuse every honest market and strand every
 * trader in it. A fixed fraction asserts the weaker true thing: whoever is
 * putting this price up must be willing to transact a defined slice of the
 * position AT IT, right now.
 *
 * AND THAT IS WHAT COSTS THE ATTACKER SOMETHING. A resting order is not a
 * signature on a form, it is a live offer that anyone may hit. Dust is free to
 * post precisely because nobody bothers to take four femto-cents, and 120 units
 * against a million of notional is very nearly as free. A level sized as a
 * fraction of the position, resting at a price pushed nineteen percent off the
 * market, is an arbitrage anyone watching can take — and it is required on BOTH
 * sides, so it cannot be hedged against itself. This does not make manipulation
 * impossible. It makes it PROPORTIONAL, which an absolute floor by construction
 * cannot.
 *
 * IT IS NOT SUFFICIENT ALONE, AND IS NOT CLAIMED TO BE. Quotes are refundable —
 * cancel and the maker is whole — so no depth rule makes the attack cost
 * anything that is not actually taken. What bounds the size of the prize is the
 * leverage cap in `initial-margin.ts`: margin genuinely at risk, in a fixed
 * ratio to the notional any mark is allowed to pay out on. Each half leaves the
 * other's hole open, and each is caught by its own test — see
 * `orderable-path.test.ts`.
 *
 * WHERE THE SIZE COMES FROM, WHICH IS THE WHOLE OF THE ADR.
 * `docs/adr/2026-08-05-futures-risk-and-mark-law.md`: *a price that moves money
 * is never supplied by the party it pays.* On the CLOSE path the size is read
 * from `trade.positions` under the same `FOR UPDATE` as the close it is judging,
 * never from the request. On the OPEN path no stored row exists yet and the size
 * is the caller's — safe in the only direction that matters, because the
 * requirement is monotonically INCREASING in it and the number is written
 * verbatim into the row by the same statement. Understating it to weaken this
 * gate also opens the smaller position that was claimed; overstating it tightens
 * the gate against the caller. Neither is a price, and neither names a payout.
 *
 * NOT WIRED INTO THE LIQUIDATION TICK, deliberately, and said out loud rather
 * than left to be discovered. A liquidation pays the HOUSE, not the trader, and
 * refusing one leaves the platform holding risk it has already judged to be past
 * its margin. Widening the conditions under which a liquidation refuses is a
 * liquidation parameter, squarely `DIRECTION` §8 item 8 — so it waits for the
 * same ruling the numbers below are waiting for, instead of arriving as a side
 * effect of a payout fix. `sideDepthNotional` is on the same boundary and for
 * the same reason: it MEASURES depth for the ladder, it does not authorise a
 * payout, so it runs the absolute floor only.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE NUMBERS ARE RISK PARAMETERS AND THEY ARE THE OWNER'S
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `docs/adr/2026-08-05-futures-risk-and-mark-law.md` reserves "any leverage or
 * margin parameter beyond §1's stated defaults" to the owner (`DIRECTION` §8
 * item 8). A minimum book depth is one of those, and so is the fraction of a
 * position that must rest behind its mark. What is implemented here is the
 * MECHANISM and its refusal; both numbers are the D26-P0-14 sealed pair
 * (`docs/adr/2026-08-13-mark-dust-floor.md`) until a listed book has observed
 * depth. They live in exactly one named constant each, on one policy object,
 * rather than scattered through the call sites.
 */
import { parseAmount, type Amount } from '@intafaced/ledger-client';
import type { EngineDepth } from '../spot/matching-client.js';
import type { DepthNotionalSource, QuotedMarkSource } from './liquidation-tick.js';
import { markSourceFromBook } from './mark-source.js';
import type { MarkPolicy } from './mark-policy.js';

/**
 * MINIMUM RESTING NOTIONAL AT A BEST LEVEL, IN QUOTE-ASSET UNITS.
 *
 * `100` means: for a `BTC/USDT-PERP` book, the best bid and the best ask must
 * each be worth at least 100 USDT (price × quantity) before their mid may be
 * minted as a payout-grade mark. Two 1-wei orders come to roughly 1e-15 quote
 * units and are refused by fifteen orders of magnitude.
 *
 * Conservative and deliberately unambitious: it is chosen to be far above dust
 * and far below anything a real market maker rests, so it catches the attack
 * without opining on what a liquid book looks like. D26-P0-14 sealed this
 * shipped `'100'` until a real market lists with observed depth — do not
 * retune it in a PR.
 *
 * KNOWN LIMITATION, stated rather than papered over: the threshold is one number
 * in QUOTE units and is applied to every futures market. That is right while
 * every futures market is quoted in USDT and wrong the day one is quoted in BTC,
 * where 100 of the quote asset is an enormous order. Per-market thresholds are a
 * risk-parameter table and squarely the owner's call, so this file does not
 * invent one — it takes a policy object so the owner's answer has somewhere to
 * land without touching any call site.
 *
 * IT GOVERNS THE VENUE PATH TOO. `mark-from-venue.ts` mids an EXTERNAL venue's
 * public book and had the identical size-blind defect; it now imports this
 * constant, this type and `bestLevelIsQuotable` rather than growing a second
 * floor with a second name. The unit is the same — quote-asset units of the
 * pair being read — and so is the reasoning, so a second default here would be
 * a second floor, not a second decision. P0-14 sealed one pair for both paths.
 * If the owner later rules DIFFERENTLY for external venues, the mechanism is
 * already there (`createConfiguredVenueMarkSource`'s `depthPolicy`) and no call
 * site has to move.
 */
export const DEFAULT_MIN_BEST_LEVEL_NOTIONAL = '100';

/**
 * HOW MUCH OF THE POSITION MUST REST BEHIND THE MARK THAT PRICES IT, IN BPS.
 *
 * `100` bps = one percent. For a long of 500 contracts, the best bid must carry
 * at least 5 contracts before its price may be half of a mid that authorises a
 * payout on that position; for a long of 10 contracts, 0.1. The requirement
 * scales with what it is being asked to authorise, which is the entire point —
 * see the header section "AN ABSOLUTE FLOOR CANNOT GATE AN UNBOUNDED PAYOUT".
 *
 * ONE PERCENT IS DELIBERATELY A WEAK CLAIM, and it is chosen to be weak. It says
 * a real market's top level can absorb a hundredth of the position being priced
 * off it — far less than any liquid book actually shows, and far more than an
 * attacker can post for free at a price nineteen percent off the market on both
 * sides at once. Against the measured exploit it is not close: 0.06 BTC rested
 * against a 500-contract position is 0.012% of it, under the requirement by two
 * orders of magnitude. Against the honest book in the same test file — 10
 * contracts resting behind a 10-contract position, 10,000 bps — it is not close
 * in the other direction either. The gap between those two is where the number
 * is allowed to be wrong without either stranding traders or paying attackers.
 *
 * IT IS THE D26-P0-14 SEALED FLOOR, NOT AN OPEN PLACEHOLDER
 * (`docs/adr/2026-08-13-mark-dust-floor.md`). The dual-floor shape is the
 * ruling; retune only from observed listed depth. What the mechanism still
 * guarantees is that the pair has exactly one place to land, and that the
 * number cannot be zero by accident: a policy that omits it gets this one, and
 * a policy whose value is unreadable gets this one too. Zero is reachable only
 * by an operator writing zero, which is a decision and reads like one.
 *
 * KNOWN LIMITATION, stated rather than papered over: like the absolute floor, it
 * is one number applied to every futures market. A market whose honest top of
 * book is genuinely thinner than 1% of the positions traded on it would freeze
 * closes rather than pay them — the ADR's chosen failure direction (the position
 * sits and an operator looks at it), but a real cost, and the reason
 * per-market risk parameters are a table the owner owns.
 */
export const DEFAULT_MIN_BEST_LEVEL_BPS_OF_NOTIONAL = 100;

/** Basis-point denominator. Integer arithmetic only — no floats in this path. */
const BPS = 10_000n;

export interface DepthQuotePolicy {
  /**
   * Decimal string, quote-asset units. A best level worth less than this is
   * read as no level at all, whatever it is being asked to price. See
   * `DEFAULT_MIN_BEST_LEVEL_NOTIONAL`.
   *
   * KEPT, and not replaced by the relative requirement below. It is what catches
   * the femto-cent book when NO position is in scope — a public ticker read, a
   * ladder depth measurement — and it is the floor under a position so small
   * that a percentage of it is also dust.
   */
  readonly minBestLevelNotional: string;
  /**
   * Basis points of the POSITION SIZE that the best level must carry before its
   * price may authorise a payout on that position. Optional; omitted means
   * `DEFAULT_MIN_BEST_LEVEL_BPS_OF_NOTIONAL`, never means "no requirement".
   */
  readonly minBestLevelBpsOfNotional?: number;
}

export const DEFAULT_DEPTH_QUOTE_POLICY: DepthQuotePolicy = {
  minBestLevelNotional: DEFAULT_MIN_BEST_LEVEL_NOTIONAL,
  minBestLevelBpsOfNotional: DEFAULT_MIN_BEST_LEVEL_BPS_OF_NOTIONAL,
};

/**
 * WHAT A BEST LEVEL MUST CARRY, AND WHAT IT IS BEING ASKED TO AUTHORISE.
 *
 * A resolved policy plus the one fact the policy cannot know: the position this
 * mark is about to price. It exists as a TYPE, rather than the two loose
 * arguments it replaces, so that the question "authorising a payout on what?"
 * has to be answered at every call site — `depthRequirement(null, …)` is a
 * caller saying out loud that no position is in scope, which is a different
 * statement from a caller who forgot.
 */
export interface DepthQuoteRequirement {
  /** Absolute floor in quote-asset units. Always applies. */
  readonly minNotional: Amount;
  /**
   * The position size, in base units, whose payout this mark would authorise —
   * or null when the read authorises nothing (public quote, ladder depth).
   *
   * NEVER a caller-supplied figure on the close path: it is read from
   * `trade.positions` under the close's own row lock. See the file header.
   */
  readonly authorisedSize: Amount | null;
  /** Basis points of `authorisedSize` the level must carry. */
  readonly bpsOfNotional: number;
}

/** Matching depth plus the time the book was observed. Missing time is not a quote. */
export type DepthSnapshot = EngineDepth & { readonly observedAt?: Date | null };

export type DepthReader = (marketId: string) => Promise<DepthSnapshot | null>;

const SCALE = 10n ** 18n;

/**
 * The policy's threshold as a scaled bigint.
 *
 * An unreadable threshold is NOT permission to skip the check — it falls back
 * to the default.
 *
 * Exported because `mark-from-venue.ts` reads the same number through the same
 * fallback. A venue's book is a book: the reason a level too small to trade
 * against is not a quote does not change because the levels arrived over HTTP
 * from somebody else's matching engine. One threshold, one fallback, one place
 * for the owner's ruling to land.
 */
export function minBestLevelNotional(policy: DepthQuotePolicy = DEFAULT_DEPTH_QUOTE_POLICY): Amount {
  try {
    return parseAmount(policy.minBestLevelNotional);
  } catch {
    return parseAmount(DEFAULT_MIN_BEST_LEVEL_NOTIONAL);
  }
}

/**
 * The policy's relative requirement in bps, through the same fallback.
 *
 * An unreadable, negative or non-integer value is NOT permission to skip the
 * relative check — it falls back to the default, exactly as the absolute floor
 * does. Zero is honoured, because zero is a value an operator can only get by
 * typing it.
 */
export function minBestLevelBpsOfNotional(policy: DepthQuotePolicy = DEFAULT_DEPTH_QUOTE_POLICY): number {
  const raw = policy.minBestLevelBpsOfNotional;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) return DEFAULT_MIN_BEST_LEVEL_BPS_OF_NOTIONAL;
  return raw;
}

/**
 * Resolve a policy and a position size into the requirement a best level faces.
 *
 * `authorisedSize` is the position, in base units, whose payout the resulting
 * mark would authorise — `null` for a read that authorises nothing. It is a
 * REQUIRED argument with no default on purpose: the header's rule is that the
 * unsafe reading must not be the one you get by leaving an argument off, and
 * here the unsafe reading is "no position in scope, absolute floor only". A
 * caller may still choose it; a caller may not fall into it.
 */
export function depthRequirement(
  authorisedSize: Amount | null,
  policy: DepthQuotePolicy = DEFAULT_DEPTH_QUOTE_POLICY,
): DepthQuoteRequirement {
  return {
    minNotional: minBestLevelNotional(policy),
    authorisedSize: authorisedSize != null && authorisedSize > 0n ? authorisedSize : null,
    bpsOfNotional: minBestLevelBpsOfNotional(policy),
  };
}

/**
 * The minimum QUANTITY a best level must carry under this requirement, in base
 * units — or null when no position is in scope, or the policy asks for none.
 *
 * ROUNDS UP, for the reason `mark-policy.ts` gives for the deviation breaker
 * rounding up: a requirement that rounds down is a requirement a small enough
 * position escapes entirely, and the absolute floor is not there to cover for
 * an off-by-one in this one.
 */
export function requiredBestLevelSize(requirement: DepthQuoteRequirement): Amount | null {
  const { authorisedSize, bpsOfNotional } = requirement;
  if (authorisedSize == null || authorisedSize <= 0n || bpsOfNotional <= 0) return null;
  const bps = BigInt(bpsOfNotional);
  const product = authorisedSize * bps;
  // Ceiling division on non-negative integers.
  return product % BPS === 0n ? product / BPS : product / BPS + 1n;
}

/**
 * Is a best level good enough to stand behind this mark? `price` and `quantity`
 * are 1e18-scaled bigints.
 *
 * THE WHOLE RULE, IN ONE FUNCTION, so "too thin to be a quote" cannot come to
 * mean one thing on our matching book and another on a venue's — and so that
 * the ABSOLUTE and RELATIVE halves cannot drift apart into two rules either.
 * Both must pass: the relative requirement is added ON TOP of the floor, not in
 * place of it, because a position small enough that 1% of it is dust still may
 * not be priced off a dust book.
 */
export function bestLevelIsQuotable(price: Amount, quantity: Amount, requirement: DepthQuoteRequirement): boolean {
  /**
   * A MALFORMED REQUIREMENT IS A THROW, NOT A PASS — and this is not defensive
   * clutter, it is the specific hole this parameter used to be.
   *
   * The third argument was a bare `Amount` (the absolute floor). Hand that
   * bigint to the new signature from any call site TypeScript is not watching —
   * a JS consumer, a test, a `dist` built before this change — and every read
   * off it is `undefined`: `notional < undefined` is `false` under
   * BigInt/Number relational coercion, `authorisedSize` is `undefined` so the
   * relative check is skipped, and the function cheerfully returns TRUE. The
   * old, exploited behaviour, restored silently, by a caller that looks correct.
   *
   * That is precisely the failure this file has now been bitten by twice —
   * a size-blind reading reachable by accident. So it is made unreachable:
   * a caller either passes something `depthRequirement()` built or finds out.
   */
  if (typeof requirement !== 'object' || requirement === null || typeof (requirement as DepthQuoteRequirement).minNotional !== 'bigint') {
    throw new TypeError(
      'bestLevelIsQuotable: third argument must be a DepthQuoteRequirement — build one with depthRequirement(size, policy)',
    );
  }
  if (price <= 0n || quantity <= 0n) return false;
  // Both operands are 1e18-scaled, so the product is 1e36-scaled. No floats.
  if ((price * quantity) / SCALE < requirement.minNotional) return false;
  const needed = requiredBestLevelSize(requirement);
  if (needed != null && quantity < needed) return false;
  return true;
}

/** One depth level as scaled bigints, or null when it is not readable as money. */
function parseLevel(level: readonly [string, string] | undefined): readonly [Amount, Amount] | null {
  if (!level) return null;
  const [price, quantity] = level;
  if (price == null || price.length === 0 || quantity == null || quantity.length === 0) return null;
  try {
    return [parseAmount(price), parseAmount(quantity)] as const;
  } catch {
    return null;
  }
}

/**
 * Best bid/ask price strings from depth levels, or null if the side is empty —
 * or too thin to be worth quoting, which this file treats as the same thing.
 *
 * `requirement` is REQUIRED and carries the position, because the unsafe reading
 * must not be the one you get by leaving an argument off. It used to be an
 * optional policy, which meant the size-aware reading was the one you had to
 * remember and the size-BLIND one was free — the shape of the defect this file
 * has now had twice. Build it with `depthRequirement(size)`, or
 * `depthRequirement(null)` where the read genuinely authorises nothing.
 */
export function bestFromDepth(
  depth: EngineDepth | null | undefined,
  requirement: DepthQuoteRequirement,
): {
  bestBid: string | null;
  bestAsk: string | null;
} {
  if (!depth) return { bestBid: null, bestAsk: null };

  const side = (level: readonly [string, string] | undefined): string | null => {
    const parsed = parseLevel(level);
    if (parsed == null || !bestLevelIsQuotable(parsed[0], parsed[1], requirement)) return null;
    return level![0]!;
  };

  return { bestBid: side(depth.bids[0]), bestAsk: side(depth.asks[0]) };
}

/**
 * QUOTE-ASSET DEPTH ON THE SIDE A POSITION WOULD BE CLOSED INTO.
 *
 * A long is closed by SELLING, which hits the bids; a short is closed by BUYING,
 * which lifts the asks. Those two numbers are routinely very different, and the
 * one that matters is the one you have to trade against — so this is deliberately
 * NOT a symmetric "book depth" figure. `maintenance-ladder.ts` rates a position
 * against it, and rating a long against a wall of asks it will never touch is the
 * same class of mistake as pricing it off a one-sided book.
 *
 * DUST IS NOT DEPTH. Every level is filtered through the same
 * `bestLevelIsQuotable` floor that decides whether a best level may mint a mid —
 * one threshold, one ruling, not a second definition of "too thin to matter" that
 * could drift away from the first. A side made entirely of dust returns null.
 *
 * THE ABSOLUTE FLOOR ONLY, AND THAT IS THE BOUNDARY. This function MEASURES how
 * much book there is; it does not authorise a payout on anything. Running the
 * relative requirement here would mean the ladder rated a position against depth
 * filtered by a fraction of that same position, which is circular, and it would
 * widen the conditions under which a LIQUIDATION refuses — a liquidation
 * parameter, and `DIRECTION` §8 item 8's, not this change's. See the header.
 *
 * NULL, NOT ZERO, when the side is unreadable. Zero depth would flow into
 * `depthRatioBps` as a division by zero; null makes the caller skip the position
 * and an operator look at it, which is what this codebase already does with a
 * missing mark.
 */
export function sideDepthNotional(
  depth: EngineDepth | null | undefined,
  side: 'long' | 'short',
  policy: DepthQuotePolicy = DEFAULT_DEPTH_QUOTE_POLICY,
): Amount | null {
  if (!depth) return null;
  const levels = side === 'long' ? depth.bids : depth.asks;
  const measuring = depthRequirement(null, policy);

  let total = 0n;
  for (const level of levels) {
    const parsed = parseLevel(level);
    if (parsed == null) continue;
    const [price, quantity] = parsed;
    if (!bestLevelIsQuotable(price, quantity, measuring)) continue;
    // Both operands are 1e18-scaled, so the product is 1e36-scaled.
    total += (price * quantity) / SCALE;
  }

  return total > 0n ? total : null;
}

/**
 * QuotedMarkSource that mids the injected book. Never invents when empty, never
 * mints a mid from a book too thin to support one, and never mints a mid too
 * thin to support THE POSITION IT IS BEING ASKED ABOUT.
 *
 * `authorisesSize` reaches here from `MarkRequest` — the caller states the
 * position, in base units, whose payout this mark would authorise. A caller with
 * no position in scope (public ticker, `markPrice` for a screen) states nothing
 * and gets the absolute floor, which is exactly what those reads should get:
 * they authorise nothing, so there is nothing to size against.
 *
 * `last` is always null here — last print is a separate feed.
 */
export function markSourceFromDepth(readDepth: DepthReader, policy?: MarkPolicy, depthPolicy?: DepthQuotePolicy): QuotedMarkSource {
  return markSourceFromBook({
    provenance: 'depth',
    policy,
    async readBook(marketId, authorisesSize) {
      const depth = await readDepth(marketId);
      if (!depth) return null;
      const observedAt = depth.observedAt;
      if (!(observedAt instanceof Date) || !Number.isFinite(observedAt.getTime())) return null;
      const { bestBid, bestAsk } = bestFromDepth(depth, depthRequirement(authorisesSize, depthPolicy ?? DEFAULT_DEPTH_QUOTE_POLICY));
      return { bestBid, bestAsk, last: null, observedAt };
    },
  });
}

/**
 * `DepthNotionalSource` over the same book the mark comes from.
 *
 * The SAME book, deliberately. Rating a position's size against one venue's depth
 * while marking it against another's would produce a maintenance requirement that
 * describes no market that exists.
 */
export function depthNotionalSourceFromDepth(readDepth: DepthReader, depthPolicy?: DepthQuotePolicy): DepthNotionalSource {
  return {
    async depthNotional({ marketId, side }) {
      const depth = await readDepth(marketId);
      return sideDepthNotional(depth, side, depthPolicy ?? DEFAULT_DEPTH_QUOTE_POLICY);
    },
  };
}
