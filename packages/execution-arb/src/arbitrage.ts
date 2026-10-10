import { type Amount, sub } from '@intafaced/ledger-client';
import { allInEffectivePrice, costRefuseToRouteReason, scoreSorCost, type SorCostTerms, type VenueKind } from '@intafaced/venue-adapter';

/**
 * §28 ARBITRAGE — EXTERNAL-ONLY SCANNER (D26-P1-X4).
 *
 * Law §28:772 + D26-P0-01 (house desk fairness ADR):
 *   · Rides the ONE ranking / cost rule from `execution.sor` (`scoreSorCost` /
 *     all-in effective price). An arb leg gets no preference of its own.
 *   · v1 is EXTERNAL-ONLY — internal house venue legs are refused, not sized.
 *   · Inventory-based execution: both sides must be pre-positioned. A DEX↔CEX
 *     (or any) opportunity that needs a bridge completing inside the spread is
 *     refused as bridge fantasy — never sized on transfer latency hope.
 *   · Never invents fees, spreads, impact, mids, or transfer. Missing cost
 *     terms → refuse (weight 0 / incomplete_cost). Unscored latency → weight 0.
 *   · Missing, non-positive, or stale quotes are skipped — a spread is never
 *     synthesised from one live leg plus a guessed mid, default bps, or a house book.
 *
 * Leverage: `@intafaced/venue-adapter` cost-model (D26-P1-X3 / #1673). This
 * package is a thin scanner path — not a second money book or SOR.
 */

/**
 * Pin: there is no default cross-exchange spread.
 *
 * Typed `null` so a later `quoted + DEFAULT_SPREAD_BPS` cannot compile without
 * changing this export. Equal quotes refuse as `no_edge` — they are never
 * filled with a house bps (including the SOR 5 bps internal tie-break).
 */
export const CROSS_EXCHANGE_DEFAULT_SPREAD_BPS: null = null;

/**
 * Pin: there is no default mid. A missing or non-positive quote is refused,
 * not filled from the other venue or from averaging two sides of a book.
 */
export const CROSS_EXCHANGE_DEFAULT_MID: null = null;

/**
 * Pin: house books get no ranking thumb. Typed `null` so a later
 * `edge + HOUSE_ARB_PREFERENCE_BPS` cannot compile without changing this export.
 */
export const HOUSE_ARB_PREFERENCE_BPS: null = null;

const INTERNAL_KINDS: ReadonlySet<VenueKind> = new Set(['internal']);

/** Venue kinds that are not house-internal (P0-01 external-only door). */
export function isExternalVenueKind(kind: VenueKind): boolean {
  return !INTERNAL_KINDS.has(kind);
}

/**
 * Cross-rail pairs that cannot close on a bridge fantasy: any leg that is
 * DEX/AMM against a CEX (or OTC) without pre-positioned inventory both sides.
 */
export function isCrossRailPair(a: VenueKind, b: VenueKind): boolean {
  const dexLike = (k: VenueKind) => k === 'external-dex' || k === 'amm';
  const cexLike = (k: VenueKind) => k === 'external-cex' || k === 'otc';
  return (dexLike(a) && cexLike(b)) || (cexLike(a) && dexLike(b));
}

/** One side of a contemplated cross-venue spot arb. Caller-supplied — no mid invent. */
export interface ArbVenueQuote {
  readonly venueId: string;
  readonly kind: VenueKind;
  /**
   * Average fill price for `amount` on this venue (walked book or firm quote).
   * `null` = missing — refuse; never substitute `CROSS_EXCHANGE_DEFAULT_MID`.
   * Non-positive (0n / negative) is the same refuse — a zero mid is not a live quote.
   */
  readonly price: Amount | null;
  /** Size available at `price`. */
  readonly amount: Amount;
  /**
   * Observation time of this quote (ms), not read time. `null` = missing —
   * refuse rather than treat as live.
   */
  readonly asOfMs: number | null;
}

/**
 * Pre-positioned inventory declaration. Missing / false on either leg of a
 * cross-rail (DEX↔CEX) pair → refuse. Same-rail CEX↔CEX still requires both
 * venues marked true so we never size on an implied transfer completing in-spread.
 */
export interface ArbInventory {
  readonly prePositionedByVenue: Readonly<Record<string, boolean>>;
}

export type ArbRefuseReason =
  | 'internal_venue'
  | 'incomplete_cost'
  | 'zero_weight'
  | 'bridge_fantasy'
  | 'inventory_missing'
  | 'missing_cost_terms'
  | 'same_venue'
  | 'no_edge'
  | 'insufficient_size'
  | 'missing_quote'
  | 'stale_quote';

export interface ArbRefusal {
  readonly ok: false;
  readonly buyVenueId: string;
  readonly sellVenueId: string;
  readonly reason: ArbRefuseReason;
  readonly detail: string;
}

export interface ArbOpportunity {
  readonly ok: true;
  readonly symbol: string;
  readonly buyVenueId: string;
  readonly sellVenueId: string;
  readonly buyKind: VenueKind;
  readonly sellKind: VenueKind;
  /** Size of the contemplated round-trip (min of both quotes). */
  readonly amount: Amount;
  /** All-in buy effective (fee + impact + transfer). */
  readonly buyAllIn: Amount;
  /** All-in sell effective (fee + impact + transfer). */
  readonly sellAllIn: Amount;
  /**
   * Gross edge per unit after all-in costs: sellAllIn − buyAllIn.
   * Positive only — non-positive pairs are refused as `no_edge`, not emitted.
   */
  readonly edgePerUnit: Amount;
  readonly buyCostBps: number;
  readonly sellCostBps: number;
}

export type ArbScanItem = ArbOpportunity | ArbRefusal;

export interface ScanExternalArbInput {
  readonly symbol: string;
  /**
   * Contemplated size. `<= 0n` refuses `insufficient_size` — no other
   * minimum is invented. Each venue must quote at least this amount or
   * that pair refuses `insufficient_size` (we do not invent depth).
   */
  readonly amount: Amount;
  readonly quotes: readonly ArbVenueQuote[];
  /** §28 complete cost model — required; omit a venue → refuse that leg. */
  readonly costTermsByVenue: Readonly<Record<string, SorCostTerms>>;
  readonly inventory: ArbInventory;
  /** Caller clock — never `Date.now()` inside the scanner. */
  readonly nowMs: number;
  /**
   * Owner freshness window. `null` / non-integer / negative → every quote is
   * stale (we do not invent a max-age).
   */
  readonly maxQuoteAgeMs: number | null;
}

export interface ScanExternalArbResult {
  readonly symbol: string;
  readonly opportunities: readonly ArbOpportunity[];
  readonly refused: readonly ArbRefusal[];
}

function inventoryReady(inventory: ArbInventory, venueId: string): boolean {
  return inventory.prePositionedByVenue[venueId] === true;
}

function scoreVenue(
  venueId: string,
  costTermsByVenue: Readonly<Record<string, SorCostTerms>>,
): { ok: true; totalCostBps: number } | { ok: false; reason: ArbRefuseReason; detail: string } {
  const terms = costTermsByVenue[venueId];
  if (!terms) {
    return {
      ok: false,
      reason: 'missing_cost_terms',
      detail: 'no SorCostTerms for venue — refuse rather than assume zeros',
    };
  }
  const scored = scoreSorCost(terms);
  if (!scored.ok) {
    const routeReason = costRefuseToRouteReason(scored.reason);
    return {
      ok: false,
      reason: routeReason === 'zero_weight' ? 'zero_weight' : 'incomplete_cost',
      detail: `${scored.reason}: ${scored.detail}`,
    };
  }
  return { ok: true, totalCostBps: scored.totalCostBps };
}

function skipRefusal(venueId: string, reason: ArbRefuseReason, detail: string): ArbRefusal {
  return { ok: false, buyVenueId: venueId, sellVenueId: venueId, reason, detail };
}

/**
 * House books are skipped before pairing — they are not a buy or sell leg.
 * P0-01: internal house MM/arb stays blocked.
 */
export function isHouseBookKind(kind: VenueKind): boolean {
  return INTERNAL_KINDS.has(kind);
}

function quoteUsable(
  quote: ArbVenueQuote,
  nowMs: number,
  maxQuoteAgeMs: number | null,
): { ok: true; price: Amount } | { ok: false; reason: ArbRefuseReason; detail: string } {
  if (quote.price === null) {
    return {
      ok: false,
      reason: 'missing_quote',
      detail: 'quote price missing — mid/spread not invented',
    };
  }
  if (quote.price <= 0n) {
    return {
      ok: false,
      reason: 'missing_quote',
      detail: 'quote price non-positive — mid not invented',
    };
  }
  if (quote.asOfMs === null || !Number.isFinite(quote.asOfMs)) {
    return {
      ok: false,
      reason: 'missing_quote',
      detail: 'quote asOf missing — not treated as live',
    };
  }
  if (maxQuoteAgeMs === null || !Number.isInteger(maxQuoteAgeMs) || maxQuoteAgeMs < 0) {
    return {
      ok: false,
      reason: 'stale_quote',
      detail: 'maxQuoteAgeMs unset — freshness window not invented',
    };
  }
  if (!Number.isFinite(nowMs)) {
    return {
      ok: false,
      reason: 'stale_quote',
      detail: 'nowMs missing — clock not invented',
    };
  }
  if (nowMs < quote.asOfMs) {
    return {
      ok: false,
      reason: 'stale_quote',
      detail: 'quote asOf is in the future of caller clock — refused',
    };
  }
  if (nowMs - quote.asOfMs > maxQuoteAgeMs) {
    return {
      ok: false,
      reason: 'stale_quote',
      detail: 'quote older than owner maxQuoteAgeMs — spread not invented from stale book',
    };
  }
  return { ok: true, price: quote.price };
}

/**
 * Scan external-only cross-exchange spot arb pairs.
 *
 * Pure: quotes, cost terms, and inventory are caller-supplied. Returns every
 * pair evaluation (opportunity or refuse) so the terminal / OMS can show why
 * a pair was not sized. House books and missing/stale/non-positive quotes
 * are skipped before pairing so they cannot invent a spread.
 */
export function scanExternalCrossExchangeArb(input: ScanExternalArbInput): ScanExternalArbResult {
  const opportunities: ArbOpportunity[] = [];
  const refused: ArbRefusal[] = [];

  const pairable: ArbVenueQuote[] = [];
  for (const quote of input.quotes) {
    if (isHouseBookKind(quote.kind) || !isExternalVenueKind(quote.kind)) {
      refused.push(skipRefusal(quote.venueId, 'internal_venue', 'D26-P0-01 external-only — house/internal book skipped, not paired'));
      continue;
    }
    const usable = quoteUsable(quote, input.nowMs, input.maxQuoteAgeMs);
    if (!usable.ok) {
      refused.push(skipRefusal(quote.venueId, usable.reason, usable.detail));
      continue;
    }
    pairable.push(quote);
  }

  const quotes = pairable;
  for (let i = 0; i < quotes.length; i++) {
    for (let j = 0; j < quotes.length; j++) {
      if (i === j) continue;
      const buyQ = quotes[i]!;
      const sellQ = quotes[j]!;

      if (buyQ.venueId === sellQ.venueId) {
        refused.push({
          ok: false,
          buyVenueId: buyQ.venueId,
          sellVenueId: sellQ.venueId,
          reason: 'same_venue',
          detail: 'arb requires distinct venues',
        });
        continue;
      }

      if (!isExternalVenueKind(buyQ.kind) || !isExternalVenueKind(sellQ.kind)) {
        refused.push({
          ok: false,
          buyVenueId: buyQ.venueId,
          sellVenueId: sellQ.venueId,
          reason: 'internal_venue',
          detail: 'D26-P0-01 external-only — internal house venue legs refused',
        });
        continue;
      }

      const buyScore = scoreVenue(buyQ.venueId, input.costTermsByVenue);
      if (!buyScore.ok) {
        refused.push({
          ok: false,
          buyVenueId: buyQ.venueId,
          sellVenueId: sellQ.venueId,
          reason: buyScore.reason,
          detail: `buy leg: ${buyScore.detail}`,
        });
        continue;
      }
      const sellScore = scoreVenue(sellQ.venueId, input.costTermsByVenue);
      if (!sellScore.ok) {
        refused.push({
          ok: false,
          buyVenueId: buyQ.venueId,
          sellVenueId: sellQ.venueId,
          reason: sellScore.reason,
          detail: `sell leg: ${sellScore.detail}`,
        });
        continue;
      }

      const buyReady = inventoryReady(input.inventory, buyQ.venueId);
      const sellReady = inventoryReady(input.inventory, sellQ.venueId);
      if (!buyReady || !sellReady) {
        const crossRail = isCrossRailPair(buyQ.kind, sellQ.kind);
        refused.push({
          ok: false,
          buyVenueId: buyQ.venueId,
          sellVenueId: sellQ.venueId,
          reason: crossRail ? 'bridge_fantasy' : 'inventory_missing',
          detail: crossRail
            ? 'DEX↔CEX (or cross-rail) without pre-positioned inventory both sides — §28:772 refuse, not size'
            : 'pre-positioned inventory required on both venues — refuse rather than imply a transfer',
        });
        continue;
      }

      if (input.amount <= 0n) {
        refused.push({
          ok: false,
          buyVenueId: buyQ.venueId,
          sellVenueId: sellQ.venueId,
          reason: 'insufficient_size',
          detail: 'contemplated amount is not strictly positive — size not invented',
        });
        continue;
      }

      if (buyQ.amount < input.amount || sellQ.amount < input.amount) {
        refused.push({
          ok: false,
          buyVenueId: buyQ.venueId,
          sellVenueId: sellQ.venueId,
          reason: 'insufficient_size',
          detail: 'quoted size below contemplated amount — depth not invented',
        });
        continue;
      }

      const buyPrice = buyQ.price;
      const sellPrice = sellQ.price;
      if (buyPrice === null || sellPrice === null || buyPrice <= 0n || sellPrice <= 0n) {
        refused.push({
          ok: false,
          buyVenueId: buyQ.venueId,
          sellVenueId: sellQ.venueId,
          reason: 'missing_quote',
          detail: 'pair reached scoring with a null or non-positive price — mid not invented',
        });
        continue;
      }

      const houseThumb: number | null = HOUSE_ARB_PREFERENCE_BPS;
      if (houseThumb !== null) {
        throw new Error('house arb preference is forbidden — do not prefer internal books');
      }
      const defaultMidPin: Amount | null = CROSS_EXCHANGE_DEFAULT_MID;
      if (defaultMidPin !== null) {
        throw new Error('cross-exchange default mid is forbidden — do not invent');
      }
      // Pin: never substitute CROSS_EXCHANGE_DEFAULT_SPREAD_BPS (null) for a
      // missing raw quote spread. Equal or inverted quotes refuse as no_edge.
      const inventedSpreadBps: number | null = CROSS_EXCHANGE_DEFAULT_SPREAD_BPS;
      if (inventedSpreadBps !== null) {
        throw new Error('cross-exchange default spread is forbidden — do not invent');
      }
      const rawSpread = sub(sellPrice, buyPrice);
      if (rawSpread <= 0n) {
        refused.push({
          ok: false,
          buyVenueId: buyQ.venueId,
          sellVenueId: sellQ.venueId,
          reason: 'no_edge',
          detail: 'quoted sell ≤ quoted buy — default spread not invented',
        });
        continue;
      }

      const buyAllIn = allInEffectivePrice(buyPrice, buyScore.totalCostBps, 'buy');
      const sellAllIn = allInEffectivePrice(sellPrice, sellScore.totalCostBps, 'sell');
      const edgePerUnit = sub(sellAllIn, buyAllIn);

      if (edgePerUnit <= 0n) {
        refused.push({
          ok: false,
          buyVenueId: buyQ.venueId,
          sellVenueId: sellQ.venueId,
          reason: 'no_edge',
          detail: 'all-in sell ≤ all-in buy after fee+impact+transfer — no opportunity',
        });
        continue;
      }

      opportunities.push({
        ok: true,
        symbol: input.symbol,
        buyVenueId: buyQ.venueId,
        sellVenueId: sellQ.venueId,
        buyKind: buyQ.kind,
        sellKind: sellQ.kind,
        amount: input.amount,
        buyAllIn,
        sellAllIn,
        edgePerUnit,
        buyCostBps: buyScore.totalCostBps,
        sellCostBps: sellScore.totalCostBps,
      });
    }
  }

  // Stable order: largest edge first (honest ranking, no house thumb).
  opportunities.sort((a, b) => (a.edgePerUnit === b.edgePerUnit ? 0 : a.edgePerUnit > b.edgePerUnit ? -1 : 1));

  return { symbol: input.symbol, opportunities, refused };
}
