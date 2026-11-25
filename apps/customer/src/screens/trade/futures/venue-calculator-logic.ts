import { formatAmount, parseAmount } from '../../../shared/money';
import type { VenueMarket } from '../../../features/trade/venue-api';

const ONE = parseAmount('1');
const BPS = parseAmount('10000');

function mulCeil(a: bigint, b: bigint): bigint {
  return (a * b + ONE - 1n) / ONE;
}

function mulFloor(a: bigint, b: bigint): bigint {
  return (a * b) / ONE;
}

function divCeil(a: bigint, b: bigint): bigint {
  return (a * ONE + b - 1n) / b;
}

function divFloor(a: bigint, b: bigint): bigint {
  return (a * ONE) / b;
}

export interface VenueCalcInput {
  side: 'long' | 'short';
  size: string;
  entryPrice: string;
  exitPrice?: string;
  leverage: string;
}

export interface VenueCalcResult {
  notional: string;
  initialMargin: string;
  tier: { index: number; maxLeverageBps: number; maintenanceRate: string } | null;
  maintenanceRate: string | null;
  maintenanceMargin: string | null;
  liquidationPrice: string | null;
  pnl: string | null;
  roePercent: string | null;
  estimatedFees: string | null;
  netPnl: string | null;
  leverageWarning: { kind: 'tier'; tier: number; maxLeverage: string } | { kind: 'market'; maxLeverage: string } | null;
}

/**
 * Pure exact-bigint margin, liquidation price and P&L calculator for a venue perpetual (J-derivatives-02 #1), driven
 * solely by the venue's published market figures (`marginTiers`, `maintenanceMarginRate`, `maxLeverageBps`,
 * `takerFeeBps`) and our published builder fee (never invented rates). Matches `TestVenueSimulator`'s isolated margin
 * and liquidation formulas unit-for-unit.
 */
export function calculateVenueMargin(
  market: Pick<VenueMarket, 'marginTiers' | 'maintenanceMarginRate' | 'maxLeverageBps' | 'takerFeeBps'>,
  input: VenueCalcInput,
  builderFeeBps: string | null,
): VenueCalcResult | null {
  let size: bigint;
  let entry: bigint;
  let leverage: bigint;
  let exit: bigint | null = null;
  try {
    size = parseAmount(input.size.trim());
    entry = parseAmount(input.entryPrice.trim());
    leverage = parseAmount(input.leverage.trim());
    if (input.exitPrice && input.exitPrice.trim() !== '') exit = parseAmount(input.exitPrice.trim());
  } catch {
    return null;
  }
  if (size <= 0n || entry <= 0n || leverage <= 0n || (exit !== null && exit <= 0n)) return null;

  const notional = mulFloor(entry, size);
  const marginPerUnit = divCeil(entry, leverage);
  const initialMargin = mulCeil(marginPerUnit, size);

  // Maintenance rate: from the venue's published tier table, else its single published maintenance rate, else unknown.
  const tiers = market.marginTiers?.known && market.marginTiers.value.length > 0 ? market.marginTiers.value : null;
  let tier: VenueCalcResult['tier'] = null;
  let maintenanceRate: bigint | null = null;
  if (tiers) {
    let idx = 0;
    for (let i = 0; i < tiers.length; i += 1) {
      if (notional >= parseAmount(tiers[i]!.fromNotional)) idx = i;
    }
    const chosen = tiers[idx]!;
    tier = { index: idx + 1, maxLeverageBps: chosen.maxLeverageBps, maintenanceRate: chosen.maintenanceRate };
    maintenanceRate = parseAmount(chosen.maintenanceRate);
  } else if (market.maintenanceMarginRate?.known) {
    maintenanceRate = parseAmount(market.maintenanceMarginRate.value);
  }

  let maintenanceMargin: bigint | null = null;
  let liquidationPrice: bigint | null = null;
  if (maintenanceRate !== null) {
    maintenanceMargin = mulFloor(notional, maintenanceRate);
    // Exact simulator formula: cushion = floor((margin - maintenance) / size), long = max(0, entry - cushion), short = entry + cushion.
    const diff = initialMargin - maintenanceMargin;
    const cushion = diff >= 0n ? divFloor(diff, size) : -divCeil(-diff, size);
    const rawLiq = input.side === 'long' ? entry - cushion : entry + cushion;
    liquidationPrice = rawLiq > 0n ? rawLiq : 0n;
  }

  // Leverage cap warning from the venue's published tier cap or market cap.
  let leverageWarning: VenueCalcResult['leverageWarning'] = null;
  if (tier && leverage > parseAmount(String(tier.maxLeverageBps / 10_000))) {
    leverageWarning = { kind: 'tier', tier: tier.index, maxLeverage: String(tier.maxLeverageBps / 10_000) };
  } else if (market.maxLeverageBps !== null && leverage > parseAmount(String(market.maxLeverageBps / 10_000))) {
    leverageWarning = { kind: 'market', maxLeverage: String(market.maxLeverageBps / 10_000) };
  }

  // P&L and ROE when exit price is entered.
  let pnl: bigint | null = null;
  let roePercent: bigint | null = null;
  let estimatedFees: bigint | null = null;
  let netPnl: bigint | null = null;
  if (exit !== null) {
    const priceDiff = input.side === 'long' ? exit - entry : entry - exit;
    pnl = (priceDiff * size) / ONE;
    if (initialMargin > 0n) {
      roePercent = (pnl * 100n * ONE) / initialMargin;
    }
    if (market.takerFeeBps.known) {
      const venueRate = parseAmount(market.takerFeeBps.value);
      const bRate = builderFeeBps !== null ? parseAmount(builderFeeBps) : 0n;
      const totalBps = venueRate + bRate;
      const entryNotional = mulCeil(entry, size);
      const exitNotional = mulCeil(exit, size);
      const entryFee = divCeil(mulCeil(entryNotional, totalBps), BPS);
      const exitFee = divCeil(mulCeil(exitNotional, totalBps), BPS);
      estimatedFees = entryFee + exitFee;
      netPnl = pnl - estimatedFees;
    }
  }

  return {
    notional: formatAmount(notional),
    initialMargin: formatAmount(initialMargin),
    tier,
    maintenanceRate: maintenanceRate === null ? null : formatAmount(maintenanceRate),
    maintenanceMargin: maintenanceMargin === null ? null : formatAmount(maintenanceMargin),
    liquidationPrice: liquidationPrice === null ? null : formatAmount(liquidationPrice),
    pnl: pnl === null ? null : formatAmount(pnl),
    roePercent: roePercent === null ? null : formatAmount(roePercent),
    estimatedFees: estimatedFees === null ? null : formatAmount(estimatedFees),
    netPnl: netPnl === null ? null : formatAmount(netPnl),
    leverageWarning,
  };
}
