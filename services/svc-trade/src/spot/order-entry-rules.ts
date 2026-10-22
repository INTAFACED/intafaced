/**
 * SP-order-entry-03 (J-cex-spot-04 steps 2-6, write half): the owner rules a
 * new order is checked against before any hold.
 *
 * Lead ruling D29(a): every rule here is a REQUIRED dependency of
 * `TradeService`. A null rule is unset and refuses with the spec code; it is
 * never read as "off" and no number is invented for it.
 *
 * - Price band: a published reference (last or the owner's mark, DEC-3) plus
 *   or minus `bandBps`. A buy above the high edge or a sell below the low edge
 *   refuses `trade.price_out_of_band`, unless the account's `priceCorrection`
 *   is `amend`, which moves the price to the edge (on the tick grid) and marks
 *   the order `priceAdjusted`. A null band refuses `trade.operator_collar`.
 *   A missing or old reference refuses `trade.reference_stale`.
 * - Open-order caps: a total across markets and one per verification level.
 *   A null cap refuses `trade.open_order_cap_unset`.
 */
import type { Sql } from 'postgres';
import { KYC_TIERS, type KycTier } from '@intafaced/config';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { TradeError, type Market, type OrderSide } from './types.js';

export type PriceCorrection = 'cancel' | 'amend';

export interface PriceReference {
  readonly price: Amount;
  /** When the reference was published. */
  readonly at: Date;
}

export interface PriceReferenceSource {
  reference(marketId: string): Promise<PriceReference | null>;
}

export interface PriceBandRule {
  /** Published half-width of the band, in basis points of the reference (1..10000). */
  readonly bandBps: number;
  /** A reference older than this (ms) is stale and refuses. */
  readonly maxReferenceAgeMs: number;
  readonly reference: PriceReferenceSource;
}

export interface OpenOrderCaps {
  /** Resting orders one account may hold across every live market. Null = unset. */
  readonly total: number | null;
  /** Resting orders per verification level. A level with no entry is unset. */
  readonly byLevel: Readonly<Partial<Record<KycTier, number>>>;
}

export interface PriceCorrectionSource {
  /** The account's preference. An account that never chose one gets the spec default `cancel`. */
  preferenceOf(userId: string): Promise<PriceCorrection>;
}

/** Required `TradeService` dependency (D29(a)). Each null member refuses with its spec code. */
export interface OrderEntryRules {
  readonly priceBand: PriceBandRule | null;
  readonly openOrderCaps: OpenOrderCaps | null;
  readonly priceCorrection: PriceCorrectionSource;
}

const BPS = 10_000n;

export interface BandEdges {
  readonly low: Amount;
  readonly high: Amount;
}

/** Band edges on the market's tick grid: high floored, low ceiled, so an amended price is always inside. */
export function bandEdges(market: Market, reference: Amount, bandBps: number): BandEdges {
  const bps = BigInt(bandBps);
  const rawHigh = (reference * (BPS + bps)) / BPS;
  const rawLow = (reference * (BPS - bps) + BPS - 1n) / BPS;
  const high = rawHigh - (rawHigh % market.tickSize);
  const lowRem = rawLow % market.tickSize;
  const low = lowRem === 0n ? rawLow : rawLow + (market.tickSize - lowRem);
  return { low, high };
}

export function validBandRule(rule: PriceBandRule): boolean {
  return (
    Number.isInteger(rule.bandBps) &&
    rule.bandBps >= 1 &&
    rule.bandBps <= 10_000 &&
    Number.isInteger(rule.maxReferenceAgeMs) &&
    rule.maxReferenceAgeMs >= 1
  );
}

/**
 * Check a priced order against the band. Returns the price to fund and submit
 * at and whether it was moved. Throws before any hold.
 */
export async function applyPriceBand(input: {
  readonly rule: PriceBandRule | null;
  readonly market: Market;
  readonly side: OrderSide;
  readonly price: Amount;
  readonly now: Date;
  readonly correction: () => Promise<PriceCorrection>;
}): Promise<{ readonly price: Amount; readonly adjusted: boolean }> {
  const { rule, market, side, price, now } = input;
  if (rule == null || !validBandRule(rule)) {
    throw new TradeError('no price band is published for this market (operator collar unset)', 'trade.operator_collar');
  }
  const ref = await rule.reference.reference(market.id);
  if (ref == null || ref.price <= 0n) {
    throw new TradeError('the price band has no published reference price for this market', 'trade.reference_stale');
  }
  const age = now.getTime() - ref.at.getTime();
  if (age > rule.maxReferenceAgeMs) {
    throw new TradeError(
      `the price band reference is ${age} ms old, older than the ${rule.maxReferenceAgeMs} ms limit`,
      'trade.reference_stale',
    );
  }
  const { low, high } = bandEdges(market, ref.price, rule.bandBps);
  const outside = side === 'buy' ? price > high : price < low;
  if (!outside) return { price, adjusted: false };
  const edge = side === 'buy' ? high : low;
  const mode = await input.correction();
  if (mode !== 'amend' || edge <= 0n) {
    throw new TradeError(
      `${side} price ${formatAmount(price)} is outside the band ${formatAmount(low)}-${formatAmount(high)}`,
      'trade.price_out_of_band',
    );
  }
  return { price: edge, adjusted: true };
}

/** Owner open-order caps. `openCount` is the account's resting live orders across markets. */
export function requireOpenOrderCaps(caps: OpenOrderCaps | null, tier: KycTier): { readonly total: number; readonly level: number } {
  if (caps == null || caps.total == null || !Number.isInteger(caps.total) || caps.total < 0) {
    throw new TradeError('the total open-order cap is not set', 'trade.open_order_cap_unset');
  }
  const level = caps.byLevel[tier];
  if (level == null || !Number.isInteger(level) || level < 0) {
    throw new TradeError(`the open-order cap for verification level ${tier} is not set`, 'trade.open_order_cap_unset');
  }
  return { total: caps.total, level };
}

export function checkOpenOrderCaps(caps: OpenOrderCaps | null, tier: KycTier, openCount: number): void {
  const { total, level } = requireOpenOrderCaps(caps, tier);
  if (openCount >= total) {
    throw new TradeError(`${openCount} open orders already rest; the total cap is ${total}`, 'trade.open_order_cap_total');
  }
  if (openCount >= level) {
    throw new TradeError(
      `${openCount} open orders already rest; the cap for verification level ${tier} is ${level}`,
      'trade.open_order_cap_level',
    );
  }
}

/** Market orders have no price to band, so they need the listing's max quantity. */
export function assertMaxQtySet(market: Market): void {
  if (market.maxQty === null) {
    throw new TradeError('this market has no maximum quantity set, so a market order is refused', 'trade.max_qty_unset');
  }
}

/** `trade.account_price_correction`; no row means the spec default `cancel`. */
export class SqlPriceCorrectionSource implements PriceCorrectionSource {
  constructor(private readonly sql: Sql) {}
  async preferenceOf(userId: string): Promise<PriceCorrection> {
    const [row] = await this.sql<Array<{ mode: string }>>`
      SELECT mode FROM trade.account_price_correction WHERE user_id = ${userId}`;
    return row?.mode === 'amend' ? 'amend' : 'cancel';
  }
}

export async function setPriceCorrection(sql: Sql, userId: string, mode: PriceCorrection): Promise<void> {
  await sql`
    INSERT INTO trade.account_price_correction (user_id, mode) VALUES (${userId}, ${mode})
    ON CONFLICT (user_id) DO UPDATE SET mode = EXCLUDED.mode, updated_at = now()`;
}

/** Last stored live fill on the market (DEC-3 "last"), with its time. */
export class LastFillPriceReference implements PriceReferenceSource {
  constructor(private readonly sql: Sql) {}
  async reference(marketId: string): Promise<PriceReference | null> {
    const [row] = await this.sql<Array<{ price: string; created_at: Date }>>`
      SELECT price::text AS price, created_at FROM trade.fills
       WHERE market_id = ${marketId} ORDER BY sequence DESC LIMIT 1`;
    if (!row) return null;
    return { price: parseAmount(row.price), at: row.created_at };
  }
}

/** Parse "basic:5,full:50". Any malformed entry makes the whole map empty, so a typo never loosens a cap. */
export function parseCapsByLevel(raw: string): Partial<Record<KycTier, number>> {
  const out: Partial<Record<KycTier, number>> = {};
  if (raw.trim() === '') return out;
  for (const part of raw.split(',')) {
    const m = /^\s*([a-z]+)\s*:\s*(\d{1,9})\s*$/.exec(part);
    if (!m || !(KYC_TIERS as readonly string[]).includes(m[1]!)) return {};
    out[m[1] as KycTier] = Number(m[2]);
  }
  return out;
}

export function orderEntryRulesFromEnv(
  sql: Sql,
  env: {
    readonly TRADE_PRICE_BAND_BPS: number | null;
    readonly TRADE_PRICE_REFERENCE_MAX_AGE_MS: number | null;
    readonly TRADE_OPEN_ORDER_CAP_TOTAL: number | null;
    readonly TRADE_OPEN_ORDER_CAP_BY_LEVEL: string;
  },
): OrderEntryRules {
  const band = env.TRADE_PRICE_BAND_BPS;
  const age = env.TRADE_PRICE_REFERENCE_MAX_AGE_MS;
  return {
    priceBand: band == null || age == null ? null : { bandBps: band, maxReferenceAgeMs: age, reference: new LastFillPriceReference(sql) },
    openOrderCaps:
      env.TRADE_OPEN_ORDER_CAP_TOTAL == null
        ? null
        : { total: env.TRADE_OPEN_ORDER_CAP_TOTAL, byLevel: parseCapsByLevel(env.TRADE_OPEN_ORDER_CAP_BY_LEVEL) },
    priceCorrection: new SqlPriceCorrectionSource(sql),
  };
}
