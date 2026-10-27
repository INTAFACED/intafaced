/**
 * The Futures ticket's decisions, apart from React so they can be tested: what size the form really asks for, when Review
 * and Open may be pressed and why not, and whether two service previews say the same thing. Money is an exact scaled
 * bigint (data/decimal.ts), never a JS number. The service preview stays the authority; this only stops what it would
 * refuse and says why in a code the screen turns into words.
 */
import { compare, dec, fractionDigits, isPositive, ratio, str, sub, times, toFixedString, ZERO } from '../../../data/decimal';
import type { FuturesListing, PositionPreview } from './api';
import { allInCost, maxSizeEstimate, percentOfSize } from './model';

export type SizeUnit = 'base' | 'contracts';
export type Side = 'long' | 'short';

/** The numbers a preview and an open are for. A preview answers only the form it was asked about. */
export interface FormKey {
  symbol: string;
  side: Side;
  size: string;
  leverage: string;
  /** What the margin is posted from. Absent is cash; any other class is sent so the service can name its refusal. */
  collateralClass?: string;
  /** Absent is market. A limit carries its price, so the review names that price's band and correction. */
  type?: 'market' | 'limit';
  limitPrice?: string;
  /** A limit outside the band is moved to the nearer edge. Absent refuses it. */
  priceCorrection?: 'adjust';
}

export const sameForm = (a: FormKey, b: FormKey): boolean =>
  a.symbol === b.symbol &&
  a.side === b.side &&
  a.size === b.size &&
  a.leverage === b.leverage &&
  (a.collateralClass ?? 'cash') === (b.collateralClass ?? 'cash') &&
  (a.type ?? 'market') === (b.type ?? 'market') &&
  a.limitPrice === b.limitPrice &&
  a.priceCorrection === b.priceCorrection;

/** The max-order refusal a split answers. */
export const MAX_ORDER_REFUSAL = 'trade.limit_max_order';

/**
 * The review as a split would see it: the same preview without the max-order line, when the service named a split and
 * that line is its only refusal. Null when there is no split to offer.
 */
export function splitPreview(preview: PositionPreview | null): PositionPreview | null {
  if (!preview?.split || preview.split.parts < 2) return null;
  const rest = preview.refusals.filter((r) => r.code !== MAX_ORDER_REFUSAL);
  if (rest.length !== preview.refusals.length - 1) return null;
  return { ...preview, orderable: rest.length === 0, refusals: rest };
}

/** Contracts are offered only where one contract is a known positive amount of the base asset (linear, published size). */
export function contractsAllowed(market: Pick<FuturesListing, 'linear' | 'contractSize'>): boolean {
  return market.linear === true && isPositive(market.contractSize);
}

/** Contracts to base amount by exact multiplication. Null when the unit is not allowed or either number is not a decimal. */
export function contractsToBase(contracts: string, market: Pick<FuturesListing, 'linear' | 'contractSize'>): string | null {
  if (!contractsAllowed(market)) return null;
  const n = dec(contracts);
  const unit = dec(market.contractSize);
  if (n === null || unit === null) return null;
  return str(times(n, unit));
}

/** The base-asset size the service is asked for. Empty or unreadable input is null, never "0". */
export function sizeInBase(raw: string, unit: SizeUnit, market: Pick<FuturesListing, 'linear' | 'contractSize'>): string | null {
  if (raw.trim() === '') return null;
  if (unit === 'contracts') return contractsToBase(raw, market);
  const n = dec(raw);
  return n === null ? null : str(n);
}

/** Decimals the size box accepts: the market's own amount step, else 6. */
export function sizePlaces(market: Pick<FuturesListing, 'precision'>): number {
  return Math.min(18, fractionDigits(market.precision.amount) ?? 6);
}

/**
 * A 25/50/75/100% size of what the free balance could carry (estimate). In contracts the base size is divided by the
 * contract size and cut down, so the button never asks for more than the estimate.
 */
export function percentSize(
  args: { free: string | null; leverage: string; mark: string | null; pct: number; unit: SizeUnit; places: number },
  market: Pick<FuturesListing, 'linear' | 'contractSize'>,
): string | null {
  const maxBase = maxSizeEstimate(args.free, args.leverage, args.mark);
  if (maxBase === null) return null;
  if (args.unit === 'base') return percentOfSize(maxBase, args.pct, args.places);
  const max = dec(maxBase);
  const unit = dec(market.contractSize);
  if (!contractsAllowed(market) || max === null || unit === null) return null;
  const inContracts = ratio(max, unit);
  return inContracts === null ? null : percentOfSize(str(inContracts), args.pct, args.places);
}

/** The margin tier the trader must name before this order is sent, or null when the order stays in its tier. */
export function tierToConfirm(preview: PositionPreview): number | null {
  return preview.riskTier?.confirmRequired ? preview.riskTier.projected : null;
}

/** Server values of two previews are identical. Order of keys is the schema's, so JSON equality is exact. */
export const previewsEqual = (a: PositionPreview, b: PositionPreview): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Distance from the previewed mark to the previewed liquidation price, percent of mark at 2 places; null if either is unknown. */
export function previewLiquidationDistance(preview: Pick<PositionPreview, 'markPrice' | 'liquidationPrice' | 'side'>): string | null {
  const mark = dec(preview.markPrice);
  const liq = dec(preview.liquidationPrice);
  if (mark === null || liq === null || mark <= ZERO) return null;
  const gap = preview.side === 'long' ? sub(mark, liq) : sub(liq, mark);
  const r = ratio(gap, mark);
  return r === null ? null : toFixedString(times(r, 100n * 10n ** 18n), 2);
}

/** The service left a key figure out, or said no. Either way the trader may not open on this preview. */
export function missingFigures(preview: PositionPreview): boolean {
  return (
    preview.markPrice === null ||
    preview.orderValue === null ||
    preview.initialMargin === null ||
    preview.estimatedFee === null ||
    preview.liquidationPrice === null ||
    preview.leverageCap === null
  );
}

/** Leverage above the published cap would be refused; saying so before sending saves a round trip. Unknown cap is not over. */
export const overCap = (leverage: string, cap: string | null): boolean => {
  const l = dec(leverage);
  const c = dec(cap);
  return l !== null && c !== null && compare(l, c) > 0;
};

export type ReviewBlock = 'planeOff' | 'signedOut' | 'markUnknown' | 'markStale' | 'noSize' | 'noLeverage' | null;

/** Review reads only, so a pending write does not stop it; a missing or old mark does. */
export function reviewBlock(a: {
  planeOff: boolean;
  signedOut: boolean;
  markKnown: boolean;
  markStale: boolean;
  size: string | null;
  leverage: string;
}): ReviewBlock {
  if (a.planeOff) return 'planeOff';
  if (a.signedOut) return 'signedOut';
  if (!a.markKnown) return 'markUnknown';
  if (a.markStale) return 'markStale';
  if (!isPositive(a.size)) return 'noSize';
  if (!isPositive(a.leverage)) return 'noLeverage';
  return null;
}

export type OpenBlock =
  | 'planeOff'
  | 'signedOut'
  | 'locked'
  | 'markUnknown'
  | 'markStale'
  | 'notReviewed'
  | 'notOrderable'
  | 'missingFigures'
  | 'overCap'
  | 'balanceUnknown'
  | 'insufficient'
  | null;

/** Why Open is off, most basic first, or null when it may be pressed. `preview` must already be the one for this form. */
export function openBlock(a: {
  planeOff: boolean;
  signedOut: boolean;
  locked: boolean;
  markKnown: boolean;
  markStale: boolean;
  preview: PositionPreview | null;
  leverage: string;
  free: string | null;
}): OpenBlock {
  if (a.planeOff) return 'planeOff';
  if (a.signedOut) return 'signedOut';
  if (a.locked) return 'locked';
  if (!a.markKnown) return 'markUnknown';
  if (a.markStale) return 'markStale';
  if (a.preview === null) return 'notReviewed';
  if (!a.preview.orderable || a.preview.refusals.length > 0) return 'notOrderable';
  if (missingFigures(a.preview)) return 'missingFigures';
  if (overCap(a.leverage, a.preview.leverageCap)) return 'overCap';
  const cost = allInCost(a.preview, a.free);
  if (cost.insufficient === null) return 'balanceUnknown';
  if (cost.insufficient) return 'insufficient';
  return null;
}
