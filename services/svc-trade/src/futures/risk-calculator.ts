/**
 * The margin tier table and the margin and P&L calculator (D-margin-03, D-account-04), from the same functions the
 * preview, the open and the liquidation tick use. Nothing here reads or writes money: it is arithmetic on what the
 * caller typed, the owner's ladder and today's book depth.
 *
 * The ladder rates a position by its notional as a share of the depth it would close into, so a tier's notional
 * bound moves with the book. The table gives the bound at today's depth on each side, and the share itself, which is
 * what the owner published.
 */
import { formatAmount, mul, mulBps, SCALE, type Amount } from '@intafaced/ledger-client';
import { initialMargin } from './initial-margin.js';
import { liquidationPriceFor } from './liquidation-price.js';
import { depthRatioBps, maintenanceBpsFor, type FuturesLadderPolicy } from './maintenance-ladder.js';
import { fillFee } from './matched-order-plan.js';

const BPS = 10_000n;

/** How each figure is worked out, in words a trader reads next to it. */
export const MARGIN_FORMULAS = Object.freeze({
  notional: 'Notional = size × entry price',
  initialMargin: 'Initial margin = size × entry price ÷ leverage',
  maintenanceMargin: 'Maintenance margin = notional × the maintenance rate of the tier the notional falls in',
  liquidationPrice:
    'Liquidation price: where margin plus P&L equals the maintenance margin. Long: (size × entry − margin) ÷ (size × (1 − rate)). ' +
    'Short: (size × entry + margin) ÷ (size × (1 + rate))',
  pnl: 'P&L = size × (exit − entry) for a long, size × (entry − exit) for a short',
  roe: 'Return on margin = P&L ÷ initial margin',
  fee: 'Fee = size × price × your taker rate, at the entry and again at the exit',
  tier: 'Tier = the position’s notional as a share of the book depth it would close into',
});

export interface RiskTier {
  readonly tier: number;
  /** The owner's bound as bps of depth. Null on the last tier, which takes every larger position. */
  readonly uptoDepthBps: number | null;
  readonly maintenanceBps: number;
  /** The largest notional in this tier at today's depth on each side; null where that side's depth is unreadable. */
  readonly notionalUpto: { readonly long: Amount | null; readonly short: Amount | null };
}

export interface DepthBySide {
  readonly long: Amount | null;
  readonly short: Amount | null;
}

/**
 * The published tiers in order. A notional is rated into a tier while `notional × 10 000 ÷ depth`, rounded up, is at
 * most its bound, so the largest notional a tier takes is `bound × depth ÷ 10 000`, rounded down.
 */
export function riskTiers(policy: FuturesLadderPolicy, depth: DepthBySide): RiskTier[] {
  return policy.tiers.map((t, index) => {
    const last = t.uptoDepthBps === Number.MAX_SAFE_INTEGER;
    const upto = (side: Amount | null): Amount | null =>
      last || side === null || side <= 0n ? null : (BigInt(t.uptoDepthBps) * side) / BPS;
    return {
      tier: index + 1,
      uptoDepthBps: last ? null : t.uptoDepthBps,
      maintenanceBps: t.maintenanceBps,
      notionalUpto: { long: upto(depth.long), short: upto(depth.short) },
    };
  });
}

/** The tier a notional falls in against a depth, as the ladder rates it (1-based). */
export function tierOf(notional: Amount, depthNotional: Amount, policy: FuturesLadderPolicy): { tier: number; maintenanceBps: number } {
  const maintenanceBps = maintenanceBpsFor(notional, depthNotional, policy);
  // maintenanceBpsFor takes the first tier whose bound holds the ratio; tiers can share a rate, so find it the same way.
  const ratioBps = depthRatioBps(notional, depthNotional);
  return { tier: policy.tiers.findIndex((t) => ratioBps <= t.uptoDepthBps) + 1, maintenanceBps };
}

export interface CalculatorInput {
  readonly side: 'long' | 'short';
  readonly size: Amount;
  readonly entryPrice: Amount;
  readonly leverage: Amount;
  readonly exitPrice: Amount | null;
  /** The account's taker rate; null when the schedule is not published (the fee lines stay empty). */
  readonly takerBps: number | null;
  readonly policy: FuturesLadderPolicy | null;
  /** Depth on the side this position would close into (bids for a long, asks for a short). */
  readonly depthNotional: Amount | null;
}

export interface CalculatorResult {
  readonly notional: Amount;
  readonly initialMargin: Amount;
  readonly tier: number | null;
  readonly maintenanceBps: number | null;
  readonly maintenanceMargin: Amount | null;
  readonly liquidationPrice: Amount | null;
  /** Why the liquidation price is empty: the ladder's own reason, or what is missing. */
  readonly liquidationReason: 'ladder_unset' | 'depth_unknown' | 'no_price_above_zero' | 'between_tiers' | null;
  readonly pnl: Amount | null;
  /** P&L ÷ initial margin, as a percentage. */
  readonly roePercent: Amount | null;
  readonly entryFee: Amount | null;
  readonly exitFee: Amount | null;
  /** P&L less both fees. */
  readonly netPnl: Amount | null;
}

/**
 * The calculator. Initial margin, maintenance and the liquidation price are the preview's and the ladder's own
 * functions, so for an entry equal to the mark the figures match the preview to the unit. Inputs must be positive.
 */
export function calculate(input: CalculatorInput): CalculatorResult {
  const notional = mul(input.size, input.entryPrice, 'ceil');
  const margin = initialMargin({ size: input.size, entryPrice: input.entryPrice, leverage: input.leverage });

  let tier: number | null = null;
  let maintenanceBps: number | null = null;
  let maintenanceMargin: Amount | null = null;
  let liquidationPrice: Amount | null = null;
  let liquidationReason: CalculatorResult['liquidationReason'] = null;
  if (!input.policy) liquidationReason = 'ladder_unset';
  else if (input.depthNotional === null || input.depthNotional <= 0n) liquidationReason = 'depth_unknown';
  else {
    const rated = tierOf(notional, input.depthNotional, input.policy);
    tier = rated.tier;
    maintenanceBps = rated.maintenanceBps;
    maintenanceMargin = mulBps(notional, rated.maintenanceBps, 'ceil');
    const liq = liquidationPriceFor({
      side: input.side,
      size: input.size,
      entryPrice: input.entryPrice,
      margin,
      depthNotional: input.depthNotional,
      policy: input.policy,
    });
    if (liq.price === null) liquidationReason = liq.reason === 'empty_position' ? 'no_price_above_zero' : liq.reason;
    else liquidationPrice = liq.price;
  }

  let pnl: Amount | null = null;
  let roePercent: Amount | null = null;
  if (input.exitPrice !== null) {
    const diff = input.side === 'long' ? input.exitPrice - input.entryPrice : input.entryPrice - input.exitPrice;
    pnl = mul(input.size, diff, 'floor');
    // P&L × 100 ÷ margin, scaled: (pnl × 100 × SCALE) ÷ margin.
    roePercent = (pnl * 100n * SCALE) / margin;
  }

  const rates = input.takerBps === null ? null : { makerBps: input.takerBps, takerBps: input.takerBps };
  const entryFee = rates ? fillFee({ qty: input.size, price: input.entryPrice, role: 'taker', rates }) : null;
  const exitFee = rates && input.exitPrice !== null ? fillFee({ qty: input.size, price: input.exitPrice, role: 'taker', rates }) : null;
  const netPnl = pnl !== null && entryFee !== null && exitFee !== null ? pnl - entryFee - exitFee : null;

  return {
    notional,
    initialMargin: margin,
    tier,
    maintenanceBps,
    maintenanceMargin,
    liquidationPrice,
    liquidationReason,
    pnl,
    roePercent,
    entryFee,
    exitFee,
    netPnl,
  };
}
