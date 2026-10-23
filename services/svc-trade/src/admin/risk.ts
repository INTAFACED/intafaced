/**
 * Per-market operator limits. A null field is unset: the order path keeps the
 * refusal it already had for a blank limit and does not invent a number.
 *
 * The two open-interest limits (D-margin-05) are read by the futures order path only
 * (`futures/open-interest-limits.ts`), where a blank one refuses every open on that market.
 *
 * The three dynamic price range values (D-instruments-08) are read by the futures price band job and order path only
 * (`futures/dynamic-price-band.ts`). Any of them blank keeps the owner's static band in force.
 */
import type { Sql } from 'postgres';
import { formatAmount, mul, parseAmount, type Amount } from '@intafaced/ledger-client';
import { TradeError } from '../spot/types.js';
import { exactDecimal, exactInteger, TradeOpsError } from './common.js';

export interface RiskLimits {
  readonly collar: string | null;
  readonly fatFinger: string | null;
  readonly slippageCap: string | null;
  readonly throttle: string | null;
  readonly circuitBreaker: string | null;
  /** A futures market's largest open interest, in its base asset (the sum of open position sizes). */
  readonly oiLimit: string | null;
  /** The largest share of `oiLimit` one account may hold, in basis points (1 to 10000). */
  readonly oiShareBps: string | null;
  /** The widest a futures market's dynamic price band may go, as a fraction of the mark (above 0, below 1). */
  readonly priceRangeMax: string | null;
  /** The premium of the futures book over the mark, as a fraction, past which the band widens (0 up to below 1). */
  readonly priceRangeTrigger: string | null;
  /** How often the band is worked out again, in whole seconds (1 to 86400). */
  readonly priceRangeCadenceSeconds: string | null;
}

/** The fields a write may leave out, keeping the current values. Added after the first five, so older callers omit them. */
export const CARRIED_RISK_FIELDS = [
  'oiLimit',
  'oiShareBps',
  'priceRangeMax',
  'priceRangeTrigger',
  'priceRangeCadenceSeconds',
] as const satisfies readonly (keyof RiskLimits)[];
type CarriedRiskField = (typeof CARRIED_RISK_FIELDS)[number];

/**
 * A write's limits. A carried field may be left out, and then the new version keeps the current value: a caller that
 * does not know it yet (an older desk) never clears it by writing the others. Null clears one.
 */
export type RiskLimitsInput = Omit<RiskLimits, CarriedRiskField> & { readonly [K in CarriedRiskField]?: string | null };

export interface RiskVersion extends RiskLimits {
  readonly marketId: string;
  readonly version: string;
  readonly operatorId: string;
  readonly approverId: string;
  readonly reason: string;
  readonly approvalId: string;
  readonly createdAt: string;
}

interface RiskRow {
  market_id: string;
  version: string;
  collar: string | null;
  fat_finger: string | null;
  slippage_cap: string | null;
  throttle: string | null;
  circuit_breaker: string | null;
  oi_limit: string | null;
  oi_share_bps: string | null;
  price_range_max: string | null;
  price_range_trigger: string | null;
  price_range_cadence_seconds: string | null;
  operator_id: string;
  approver_id: string;
  reason: string;
  approval_id: string;
  created_at: Date;
}

const EMPTY: RiskLimits = {
  collar: null,
  fatFinger: null,
  slippageCap: null,
  throttle: null,
  circuitBreaker: null,
  oiLimit: null,
  oiShareBps: null,
  priceRangeMax: null,
  priceRangeTrigger: null,
  priceRangeCadenceSeconds: null,
};

function present(row: RiskRow): RiskVersion {
  return {
    marketId: row.market_id,
    version: row.version,
    collar: row.collar,
    fatFinger: row.fat_finger,
    slippageCap: row.slippage_cap,
    throttle: row.throttle,
    circuitBreaker: row.circuit_breaker,
    oiLimit: row.oi_limit,
    oiShareBps: row.oi_share_bps,
    priceRangeMax: row.price_range_max,
    priceRangeTrigger: row.price_range_trigger,
    priceRangeCadenceSeconds: row.price_range_cadence_seconds,
    operatorId: row.operator_id,
    approverId: row.approver_id,
    reason: row.reason,
    approvalId: row.approval_id,
    createdAt: row.created_at.toISOString(),
  };
}

export function validateLimits(input: RiskLimitsInput): RiskLimitsInput {
  const collar = input.collar == null ? null : exactDecimal(input.collar, 'collar');
  const fatFinger = input.fatFinger == null ? null : exactDecimal(input.fatFinger, 'fatFinger');
  const slippageCap = input.slippageCap == null ? null : exactInteger(input.slippageCap, 'slippageCap');
  const throttle = input.throttle == null ? null : exactInteger(input.throttle, 'throttle');
  const circuitBreaker = input.circuitBreaker == null ? null : exactInteger(input.circuitBreaker, 'circuitBreaker');
  // A band is a fraction of the price on each side: 0 would refuse every price, 1 or more would take a buy at any
  // price and a sell at zero.
  if (collar != null && (parseAmount(collar) <= 0n || parseAmount(collar) >= parseAmount('1'))) {
    throw new TradeOpsError('risk_limit_not_exact', 'collar must be a fraction above 0 and below 1 (0.1 is 10%)');
  }
  if (slippageCap != null) {
    const bps = Number(slippageCap);
    if (!Number.isInteger(bps) || bps < 1 || bps > 5000) {
      throw new TradeOpsError('risk_limit_not_exact', 'slippageCap must be an integer basis-point string from 1 to 5000');
    }
  }
  const oiLimit = input.oiLimit == null ? input.oiLimit : exactDecimal(input.oiLimit, 'oiLimit');
  const oiShareBps = input.oiShareBps == null ? input.oiShareBps : exactInteger(input.oiShareBps, 'oiShareBps');
  if (oiLimit != null) {
    // Read as the order path reads it, so a stored limit is never one the order path cannot read (and takes for blank).
    try {
      parseAmount(oiLimit);
    } catch {
      throw new TradeOpsError('risk_limit_not_exact', 'oiLimit must be a decimal amount the ledger can hold');
    }
  }
  if (oiShareBps != null) {
    const bps = Number(oiShareBps);
    if (!Number.isInteger(bps) || bps < 1 || bps > 10_000) {
      throw new TradeOpsError('risk_limit_not_exact', 'oiShareBps must be an integer basis-point string from 1 to 10000');
    }
  }
  const priceRangeMax = input.priceRangeMax == null ? input.priceRangeMax : exactDecimal(input.priceRangeMax, 'priceRangeMax');
  const priceRangeTrigger =
    input.priceRangeTrigger == null ? input.priceRangeTrigger : exactDecimal(input.priceRangeTrigger, 'priceRangeTrigger');
  const priceRangeCadenceSeconds =
    input.priceRangeCadenceSeconds == null
      ? input.priceRangeCadenceSeconds
      : exactInteger(input.priceRangeCadenceSeconds, 'priceRangeCadenceSeconds');
  // The widest band is a fraction of the mark on each side, as the static band is: 0 is no band, 1 or more takes any price.
  if (priceRangeMax != null && !fractionBelowOne(priceRangeMax, false)) {
    throw new TradeOpsError('risk_limit_not_exact', 'priceRangeMax must be a fraction above 0 and below 1 (0.1 is 10%)');
  }
  if (priceRangeTrigger != null && !fractionBelowOne(priceRangeTrigger, true)) {
    throw new TradeOpsError('risk_limit_not_exact', 'priceRangeTrigger must be a fraction from 0 to below 1 (0.01 is 1%)');
  }
  if (priceRangeCadenceSeconds != null) {
    const seconds = Number(priceRangeCadenceSeconds);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86_400) {
      throw new TradeOpsError('risk_limit_not_exact', 'priceRangeCadenceSeconds must be a whole number of seconds from 1 to 86400');
    }
  }
  // Left out stays left out, so the approval's hash covers exactly what the caller sent.
  return {
    collar,
    fatFinger,
    slippageCap,
    throttle,
    circuitBreaker,
    ...(oiLimit !== undefined ? { oiLimit } : {}),
    ...(oiShareBps !== undefined ? { oiShareBps } : {}),
    ...(priceRangeMax !== undefined ? { priceRangeMax } : {}),
    ...(priceRangeTrigger !== undefined ? { priceRangeTrigger } : {}),
    ...(priceRangeCadenceSeconds !== undefined ? { priceRangeCadenceSeconds } : {}),
  };
}

function fractionBelowOne(text: string, zeroAllowed: boolean): boolean {
  let value: Amount;
  try {
    value = parseAmount(text);
  } catch {
    return false;
  }
  return (zeroAllowed ? value >= 0n : value > 0n) && value < parseAmount('1');
}

/**
 * The dynamic price range is three values that only work together: a version with one or two of them would be
 * approved and then never widen anything. All three set, or none, is the only shape a version may hold.
 */
export function assertPriceRangeWhole(limits: Pick<RiskLimits, 'priceRangeMax' | 'priceRangeTrigger' | 'priceRangeCadenceSeconds'>): void {
  const set = [limits.priceRangeMax, limits.priceRangeTrigger, limits.priceRangeCadenceSeconds].filter((v) => v != null).length;
  if (set !== 0 && set !== 3) {
    throw new TradeOpsError(
      'risk_limit_not_exact',
      'the price range is priceRangeMax, priceRangeTrigger and priceRangeCadenceSeconds together: set all three, or clear all three',
    );
  }
}

/** The new version's carried fields: what the write sent, else the current version's value, else unset. */
export function carriedLimits(limits: RiskLimitsInput, current: RiskLimits | null): Pick<RiskLimits, CarriedRiskField> {
  const out = {} as Record<CarriedRiskField, string | null>;
  for (const field of CARRIED_RISK_FIELDS) out[field] = limits[field] !== undefined ? limits[field]! : (current?.[field] ?? null);
  return out;
}

// Every ORDER BY names the table's bigint column: a bare `version` sorts by the `version::text` output column, where
// "9" comes after "10", so from version 10 on the latest row read as an older one.
export async function currentRisk(sql: Sql, marketId: string): Promise<RiskVersion | null> {
  const [row] = await sql<RiskRow[]>`
    SELECT market_id, version::text, collar, fat_finger, slippage_cap, throttle, circuit_breaker, oi_limit, oi_share_bps,
           price_range_max, price_range_trigger, price_range_cadence_seconds,
           operator_id, approver_id, reason, approval_id, created_at
      FROM trade.operator_risk_limits
     WHERE market_id = ${marketId}
     ORDER BY operator_risk_limits.version DESC
     LIMIT 1`;
  return row ? present(row) : null;
}

/**
 * SP-order-entry-03: the latest approved version for many markets in ONE
 * query (DISTINCT ON market_id, newest version first). A market with no row
 * is absent from the map, never given a default.
 */
export async function currentRiskForMarkets(sql: Sql, marketIds: readonly string[]): Promise<Map<string, RiskVersion>> {
  const out = new Map<string, RiskVersion>();
  if (marketIds.length === 0) return out;
  const rows = await sql<RiskRow[]>`
    SELECT DISTINCT ON (market_id)
           market_id, version::text, collar, fat_finger, slippage_cap, throttle, circuit_breaker, oi_limit, oi_share_bps,
           price_range_max, price_range_trigger, price_range_cadence_seconds,
           operator_id, approver_id, reason, approval_id, created_at
      FROM trade.operator_risk_limits
     WHERE market_id = ANY(${[...marketIds]}::uuid[])
     ORDER BY market_id, operator_risk_limits.version DESC`;
  for (const row of rows) out.set(row.market_id, present(row));
  return out;
}

export async function riskHistory(sql: Sql, marketId: string): Promise<RiskVersion[]> {
  const rows = await sql<RiskRow[]>`
    SELECT market_id, version::text, collar, fat_finger, slippage_cap, throttle, circuit_breaker, oi_limit, oi_share_bps,
           price_range_max, price_range_trigger, price_range_cadence_seconds,
           operator_id, approver_id, reason, approval_id, created_at
      FROM trade.operator_risk_limits
     WHERE market_id = ${marketId}
     ORDER BY operator_risk_limits.version ASC`;
  return rows.map(present);
}

export function riskView(marketId: string, row: RiskVersion | null): RiskLimits & { marketId: string; version: string } {
  return { marketId, version: row?.version ?? '0', ...(row ?? EMPTY) };
}

/** The best bid and ask matching shows now; either side may be empty. */
export interface Touch {
  readonly bid: Amount | null;
  readonly ask: Amount | null;
}

/**
 * The price band a priced order must stay inside: the collar is a fraction of the reference price (0.1 is 10%), and
 * the reference is the middle of the best bid and ask, or the one side that has an order. The edges are kept on the
 * tick and inside the band (the low edge rounds up, the high edge down). An empty book has no band (null): no price is
 * invented, and an order on an empty book cannot trade against anything, so the band has nothing to guard. This is how
 * a market's first quotes can rest.
 */
export function priceBandFor(collar: string, touch: Touch, tickSize: Amount): { readonly low: Amount; readonly high: Amount } | null {
  const reference = touch.bid != null && touch.ask != null ? (touch.bid + touch.ask) / 2n : (touch.bid ?? touch.ask);
  if (reference == null) return null;
  const width = mul(reference, parseAmount(collar), 'floor');
  const rawLow = reference > width ? reference - width : 0n;
  const rawHigh = reference + width;
  const lowRemainder = rawLow % tickSize;
  const low = lowRemainder === 0n ? rawLow : rawLow + (tickSize - lowRemainder);
  const high = rawHigh - (rawHigh % tickSize);
  return { low, high };
}

/**
 * Order-path gate, the same for place and for the order check before Confirm. With `requirePublished`, the price band
 * and the open-order cap are owner values the pair must publish: a priced order on a pair with no band refuses
 * `trade.price_band_unset`, and an order that can rest on a pair with no cap refuses `trade.open_orders_cap_unset`.
 * Nothing defaults (J-cex-spot-04 step 6). The other fields do nothing while unset. A set
 * fat-finger, price band (collar) or open-order cap (throttle) is enforced here. A buy priced above the band or a sell
 * priced below it refuses `trade.price_band` with the band's edges; an order that can rest, when the account already
 * has the cap's number open on this market, refuses `trade.operator_throttle` with the cap and how many are open. A set circuit breaker has no reference mark in this path, so the order
 * refuses rather than inventing a price. A set slippage cap is applied by `operatorSlippageCapBps` at the existing
 * cap site.
 */
export async function assertOperatorRiskOnPlace(
  sql: Sql,
  market: { readonly id: string; readonly tickSize: Amount },
  userId: string,
  input: {
    readonly side: 'buy' | 'sell';
    readonly price: Amount | null;
    readonly qty: Amount;
    /** The order can rest (not market, IOC or FOK, not a replacement): only such an order counts against the cap. */
    readonly rests: boolean;
    /** A bracket's exit for a filled entry: the band never refuses it, or the position would be left without its stop. */
    readonly protective?: boolean;
  },
  touch: () => Promise<Touch>,
  requirePublished = true,
): Promise<void> {
  const limits = await currentRisk(sql, market.id);
  if (requirePublished && input.protective !== true) {
    if (input.price != null && limits?.collar == null) {
      throw new TradeError('no price band is published for this market', 'trade.price_band_unset', { rule: 'price band' });
    }
    if (input.rests && limits?.throttle == null) {
      throw new TradeError('no open-order cap is published for this market', 'trade.open_orders_cap_unset', { rule: 'open-order cap' });
    }
  }
  if (!limits) return;
  if (limits.fatFinger != null) {
    if (input.price == null) {
      throw new TradeError('fat-finger limit is set and this order has no price to value against it', 'trade.operator_fat_finger');
    }
    const notional = mul(input.price, input.qty, 'floor');
    if (notional > parseAmount(limits.fatFinger)) {
      throw new TradeError(
        `order notional ${formatAmount(notional)} exceeds the operator fat-finger limit ${limits.fatFinger}`,
        'trade.operator_fat_finger',
      );
    }
  }
  if (limits.collar != null && input.price != null && input.protective !== true) {
    const band = priceBandFor(limits.collar, await touch(), market.tickSize);
    if (band != null && (input.side === 'buy' ? input.price > band.high : input.price < band.low)) {
      const low = formatAmount(band.low);
      const high = formatAmount(band.high);
      throw new TradeError(`order price is outside the price band ${low} to ${high}`, 'trade.price_band', {
        low,
        high,
        collar: limits.collar,
      });
    }
  }
  if (limits.throttle != null && input.rests) {
    const [row] = await sql<Array<{ n: string }>>`
      SELECT count(*)::text AS n FROM trade.orders
       WHERE market_id = ${market.id} AND user_id = ${userId} AND status IN ('open', 'pending')`;
    const open = row?.n ?? '0';
    if (BigInt(open) >= BigInt(limits.throttle)) {
      throw new TradeError(
        `${open} orders are open on this market and the open-order cap is ${limits.throttle}`,
        'trade.operator_throttle',
        { cap: limits.throttle, open },
      );
    }
  }
  if (limits.circuitBreaker != null) {
    throw new TradeError(
      'circuit breaker is set and no reference mark is configured (circuit_breaker_reference_unset)',
      'trade.circuit_breaker_reference_unset',
    );
  }
}

/** Integer bps from the latest operator row, or null when that field is blank. */
export async function operatorSlippageCapBps(sql: Sql, marketId: string): Promise<number | null> {
  const limits = await currentRisk(sql, marketId);
  if (limits?.slippageCap == null) return null;
  const bps = Number(limits.slippageCap);
  if (!Number.isInteger(bps)) return null;
  return bps;
}
