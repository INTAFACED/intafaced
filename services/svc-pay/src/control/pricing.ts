import { formatAmount, mulBps, parseAmount, type Amount, type Rounding } from '@intafaced/ledger-client';
import { MAX_FEE_BPS } from '../fee-bps-bound.js';

/**
 * PRICING ENGINE — pure functions over scaled bigint amounts.
 *
 * Nothing here knows a fee. Every number arrives in a rule an owner configured;
 * a rule that is missing, or whose rounding direction is unset, means the caller
 * REFUSES (`pay.pricing_unconfigured`). There is no default rate and no default
 * rounding.
 *
 * LAYERING. For one asset the most specific layer that has a rule wins, as a
 * whole rule (merchant, then tier, then global). Layers are never blended field
 * by field: a merchant rule with no spread means "no spread", not "inherit".
 *
 * BANDS. `bands` is ascending by `fromAmount`, the first band starts at 0. The
 * band that applies is the highest one whose `fromAmount` is at or below the
 * month's volume BEFORE this item (a step schedule: the whole item is priced at
 * the band the merchant had reached, not marginally across bands).
 *
 * ROUNDING. `roundingBeneficiary` says who keeps the fractional minor unit of a
 * percentage amount: `platform` rounds the fee UP (ceil), `merchant` rounds it
 * DOWN (floor). The mode used is returned and recorded on the snapshot. A flat
 * fee is exact and never rounded.
 */

export type RoundingBeneficiary = 'platform' | 'merchant';
export type PricingLayer = 'global' | 'tier' | 'merchant';

export interface PricingBand {
  readonly fromAmount: Amount;
  readonly feeBps: number;
  readonly flatFee: Amount | null;
}

export interface PricingRule {
  readonly id: string;
  readonly layer: PricingLayer;
  /** '' for global. */
  readonly scopeId: string;
  readonly assetCode: string;
  readonly bands: readonly PricingBand[];
  readonly spreadBps: number | null;
  readonly roundingBeneficiary: RoundingBeneficiary;
  readonly minFee: Amount | null;
  readonly maxFee: Amount | null;
  readonly version: bigint;
}

const LAYER_RANK: Record<PricingLayer, number> = { global: 0, tier: 1, merchant: 2 };

export interface ResolvedRule {
  readonly rule: PricingRule;
  /** Every layer that had a rule for the asset, least to most specific. */
  readonly chain: ReadonlyArray<{ layer: PricingLayer; ruleId: string; version: string }>;
}

/** The most specific rule for `assetCode`, or null when no layer has one. */
export function resolvePricingRule(candidates: readonly PricingRule[], assetCode: string): ResolvedRule | null {
  const forAsset = candidates.filter((r) => r.assetCode === assetCode).sort((a, b) => LAYER_RANK[a.layer] - LAYER_RANK[b.layer]);
  const rule = forAsset[forAsset.length - 1];
  if (!rule) return null;
  return { rule, chain: forAsset.map((r) => ({ layer: r.layer, ruleId: r.id, version: r.version.toString() })) };
}

export function roundingMode(beneficiary: RoundingBeneficiary): Extract<Rounding, 'ceil' | 'floor'> {
  if (beneficiary === 'platform') return 'ceil';
  if (beneficiary === 'merchant') return 'floor';
  throw new PricingConfigError('rounding beneficiary must be platform or merchant');
}

export class PricingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PricingConfigError';
  }
}

/** Throws `PricingConfigError` for a rule that must not be stored or used. */
export function assertValidRule(rule: Pick<PricingRule, 'bands' | 'spreadBps' | 'roundingBeneficiary' | 'minFee' | 'maxFee'>): void {
  roundingMode(rule.roundingBeneficiary);
  if (rule.bands.length === 0) throw new PricingConfigError('a rule needs at least one band');
  if (rule.bands[0]!.fromAmount !== 0n) throw new PricingConfigError('the first band must start at 0 so every volume has a band');
  for (let i = 0; i < rule.bands.length; i += 1) {
    const band = rule.bands[i]!;
    if (!Number.isInteger(band.feeBps) || band.feeBps < 0 || band.feeBps > MAX_FEE_BPS)
      throw new PricingConfigError(`band feeBps must be 0..${MAX_FEE_BPS}`);
    if (band.flatFee !== null && band.flatFee < 0n) throw new PricingConfigError('band flatFee must not be negative');
    if (i > 0 && band.fromAmount <= rule.bands[i - 1]!.fromAmount) throw new PricingConfigError('bands must be strictly ascending');
  }
  if (rule.spreadBps !== null && (!Number.isInteger(rule.spreadBps) || rule.spreadBps < 0 || rule.spreadBps > 10_000))
    throw new PricingConfigError('spreadBps must be 0..10000');
  if (rule.minFee !== null && rule.minFee < 0n) throw new PricingConfigError('minFee must not be negative');
  if (rule.maxFee !== null && rule.maxFee < 0n) throw new PricingConfigError('maxFee must not be negative');
  if (rule.minFee !== null && rule.maxFee !== null && rule.minFee > rule.maxFee)
    throw new PricingConfigError('minFee must not exceed maxFee');
}

export interface PricingInput {
  /** Amount the fee is charged on (payment amount, or settlement gross). */
  readonly amount: Amount;
  /** The month's volume before this item, in the same asset. Selects the band. */
  readonly monthlyVolumeBefore: Amount;
  /** Spread applies only to a USD to USDT conversion; absent = no spread computed. */
  readonly conversion?: boolean;
}

export interface PricingQuote {
  readonly ruleId: string;
  readonly layer: PricingLayer;
  readonly bandFrom: Amount;
  readonly feeBps: number;
  readonly flatFee: Amount | null;
  readonly spreadBps: number | null;
  readonly roundingBeneficiary: RoundingBeneficiary;
  readonly roundingMode: 'ceil' | 'floor';
  /** amount x feeBps, rounded. */
  readonly bpsFee: Amount;
  /** bpsFee + flatFee, before min/max. */
  readonly feeBeforeClamp: Amount;
  /** After min/max. */
  readonly fee: Amount;
  /** Spread amount, or null when no conversion or no spread configured. */
  readonly spread: Amount | null;
  /** amount - fee - spread. May be zero or negative: the caller decides whether that refuses. */
  readonly net: Amount;
}

export function selectBand(rule: Pick<PricingRule, 'bands'>, monthlyVolumeBefore: Amount): PricingBand {
  let chosen = rule.bands[0];
  for (const band of rule.bands) if (band.fromAmount <= monthlyVolumeBefore) chosen = band;
  if (!chosen) throw new PricingConfigError('rule has no bands');
  return chosen;
}

export function computePricing(rule: PricingRule, input: PricingInput): PricingQuote {
  assertValidRule(rule);
  if (input.amount < 0n) throw new PricingConfigError('amount must not be negative');
  const mode = roundingMode(rule.roundingBeneficiary);
  const band = selectBand(rule, input.monthlyVolumeBefore);
  const bpsFee = mulBps(input.amount, band.feeBps, mode);
  const feeBeforeClamp = bpsFee + (band.flatFee ?? 0n);
  let fee = feeBeforeClamp;
  if (rule.minFee !== null && fee < rule.minFee) fee = rule.minFee;
  if (rule.maxFee !== null && fee > rule.maxFee) fee = rule.maxFee;
  const spread = input.conversion && rule.spreadBps !== null ? mulBps(input.amount, rule.spreadBps, mode) : null;
  return {
    ruleId: rule.id,
    layer: rule.layer,
    bandFrom: band.fromAmount,
    feeBps: band.feeBps,
    flatFee: band.flatFee,
    spreadBps: rule.spreadBps,
    roundingBeneficiary: rule.roundingBeneficiary,
    roundingMode: mode,
    bpsFee,
    feeBeforeClamp,
    fee,
    spread,
    net: input.amount - fee - (spread ?? 0n),
  };
}

export interface ReserveConfig {
  readonly bps: number;
  readonly holdDays: number;
}

export interface ReserveQuote {
  readonly bps: number;
  readonly holdDays: number;
  readonly amount: Amount;
  readonly releaseAt: Date;
}

/**
 * Rolling reserve withheld from a settlement NET. Rounds with the same
 * beneficiary rule as the fee (platform = hold the extra unit). Pure: it books
 * nothing; see reserve.ts for the (unwired) ledger side.
 */
export function computeReserve(net: Amount, config: ReserveConfig, beneficiary: RoundingBeneficiary, at: Date): ReserveQuote {
  if (!Number.isInteger(config.bps) || config.bps < 0 || config.bps > 10_000) throw new PricingConfigError('reserve bps must be 0..10000');
  if (!Number.isInteger(config.holdDays) || config.holdDays < 0 || config.holdDays > 365)
    throw new PricingConfigError('reserve holdDays must be 0..365');
  const amount = mulBps(net < 0n ? 0n : net, config.bps, roundingMode(beneficiary));
  return { bps: config.bps, holdDays: config.holdDays, amount, releaseAt: new Date(at.getTime() + config.holdDays * 86_400_000) };
}

/** Wire helpers: decimal strings in and out. */
export const toAmount = (value: string): Amount => parseAmount(value);
export const fromAmount = (value: Amount): string => formatAmount(value);
