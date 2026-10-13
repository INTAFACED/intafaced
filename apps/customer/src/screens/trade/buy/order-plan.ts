/**
 * What the Buy card can send, worked out before anything goes to the service (UI-SPEC 5.9).
 *
 * `planOrder` turns what the customer typed (dollars or coins) into a market-order size that is a whole number of
 * the market's lot, and refuses, in the customer's unit, anything below the published minimums. The service still
 * checks all of it again in its preview; this only saves a round trip and says it in plain words.
 */
import type { MarketRow } from '../../../data';
import {
  ceilPlaces,
  ceilToStep,
  divDown,
  divUp,
  floorToStep,
  isMultipleOf,
  mulDown,
  mulUp,
  bpsRatio,
  dec,
  str,
  type Scaled,
} from './trade-math';

/** Coins are paid for in these, best first. USDT and USDC count as one US dollar (UI-SPEC 1.2). */
export const PAY_ASSETS = ['USDT', 'USDC'] as const;
export type PayAsset = (typeof PAY_ASSETS)[number];
export const isPayAsset = (asset: string): asset is PayAsset => (PAY_ASSETS as readonly string[]).includes(asset);

export interface CoinOption {
  base: string;
  /** Orderable markets for the coin, keyed by the asset that pays for it. */
  markets: Partial<Record<PayAsset, MarketRow>>;
}

const LEADING = ['BTC', 'ETH', 'IFC'];

/** Coins that can be bought with USDT or USDC on an open market, BTC, ETH and IFC first, then A to Z. */
export function coinOptions(markets: readonly MarketRow[]): CoinOption[] {
  const byBase = new Map<string, CoinOption>();
  for (const market of markets) {
    if (!market.orderable || isPayAsset(market.base) || !isPayAsset(market.quote)) continue;
    const option = byBase.get(market.base) ?? { base: market.base, markets: {} };
    option.markets[market.quote] = market;
    byBase.set(market.base, option);
  }
  const rank = (base: string) => {
    const at = LEADING.indexOf(base);
    return at >= 0 ? at : LEADING.length;
  };
  return [...byBase.values()].sort((a, b) => rank(a.base) - rank(b.base) || a.base.localeCompare(b.base));
}

/** The assets that can pay for a coin, USDT first. */
export function payOptions(coin: CoinOption): PayAsset[] {
  return PAY_ASSETS.filter((asset) => coin.markets[asset]);
}

/** The market to use: the asked-for payer if that market is open, else USDT, else USDC. */
export function marketFor(coin: CoinOption, payer?: string | null): MarketRow | null {
  if (payer && isPayAsset(payer) && coin.markets[payer]) return coin.markets[payer]!;
  return payOptions(coin).map((asset) => coin.markets[asset]!)[0] ?? null;
}

export type Unit = 'quote' | 'base';

export type PlanProblem =
  /** Nothing (or zero) typed: no message, the button just waits. */
  | { kind: 'empty' }
  /** A dollar amount needs a live price to become a coin amount. */
  | { kind: 'noPrice' }
  /** A coin amount that is not a whole number of the market's lot. */
  | { kind: 'notOnLot'; step: string }
  /** Below the minimum; `min` is in the unit the customer is typing and `asset` names it. */
  | { kind: 'tooSmall'; min: string; asset: string };

export type OrderPlan = { ok: true; base: string; baseScaled: Scaled; notional: string | null } | { ok: false; problem: PlanProblem };

export interface PlanInput {
  unit: Unit;
  /** What was typed: dollars when `unit` is quote, coins when it is base. */
  amount: string;
  /** The price the order is sized from: the ask for a buy, the bid for a sell. */
  price: string | null;
  lot: string;
  minAmount: string | null;
  minCost: string | null;
  baseAsset: string;
  quoteAsset: string;
}

const fail = (problem: PlanProblem): OrderPlan => ({ ok: false, problem });

/**
 * Whole lots only, rounded DOWN, so the order never costs more than what was typed. Minimums are checked here in the
 * customer's own unit; the service repeats every check in its preview.
 */
export function planOrder(input: PlanInput): OrderPlan {
  const typed = dec(input.amount);
  if (typed === null || typed <= 0n) return fail({ kind: 'empty' });
  const lot = dec(input.lot);
  if (lot === null || lot <= 0n) return fail({ kind: 'noPrice' });
  const price = dec(input.price);
  const minAmount = dec(input.minAmount) ?? 0n;
  const minCost = dec(input.minCost) ?? 0n;
  const smallestBase = minAmount > lot ? minAmount : lot;

  let base: Scaled;
  if (input.unit === 'base') {
    if (!isMultipleOf(typed, lot)) return fail({ kind: 'notOnLot', step: input.lot });
    base = typed;
  } else {
    if (price === null || price <= 0n) return fail({ kind: 'noPrice' });
    const raw = divDown(typed, price);
    base = raw === null ? 0n : floorToStep(raw, lot);
  }

  if (input.unit === 'quote') {
    // The smallest spend that buys one valid order, rounded up to cents.
    const minSpend =
      price === null
        ? minCost
        : (() => {
            const forLot = mulUp(smallestBase, price);
            return ceilPlaces(forLot > minCost ? forLot : minCost, 2);
          })();
    if (base <= 0n || base < minAmount || (price !== null && mulDown(base, price) < minCost))
      return fail({ kind: 'tooSmall', min: str(minSpend), asset: input.quoteAsset });
    return { ok: true, base: str(base), baseScaled: base, notional: price === null ? null : str(mulDown(base, price)) };
  }

  if (base < smallestBase) return fail({ kind: 'tooSmall', min: str(smallestBase), asset: input.baseAsset });
  if (price !== null && minCost > 0n && mulDown(base, price) < minCost) {
    const needed = divUp(minCost, price);
    return fail({ kind: 'tooSmall', min: str(needed === null ? smallestBase : ceilToStep(needed, lot)), asset: input.baseAsset });
  }
  return { ok: true, base: str(base), baseScaled: base, notional: price === null ? null : str(mulDown(base, price)) };
}

export interface MaxInput {
  side: 'buy' | 'sell';
  /** Free balance of the asset that is spent: the payer for a buy, the coin for a sell. */
  available: string | null;
  /** Buy: the protection price the service reserves funds at (the worst price the order may fill at). */
  holdPrice: string | null;
  lot: string;
  /** The service's fee rate in basis points, and the asset it is taken in. */
  feeBps: number | null;
  feeAsset: string | null;
  /** The asset the available balance is in. */
  spendAsset: string;
}

/**
 * The most a customer can send: the available balance MINUS the fee, in whole lots, rounded down. A buy reserves
 * funds at the protection price (the worst price it may fill at), not at the ask, so that price sizes the order.
 * Null when anything needed is unknown: Max then does nothing rather than guess.
 */
export function maxBase(input: MaxInput): string | null {
  const available = dec(input.available);
  const lot = dec(input.lot);
  if (available === null || available <= 0n || lot === null || lot <= 0n || input.feeBps === null) return null;
  const feeRatio = bpsRatio(input.feeBps);
  // A fee taken from the very asset being spent shrinks what is left to spend: spend + fee <= available.
  const spendable = input.feeAsset === input.spendAsset ? divDown(available, bpsRatio(10_000) + feeRatio) : available;
  if (spendable === null) return null;
  if (input.side === 'sell') {
    const base = floorToStep(spendable, lot);
    return base > 0n ? str(base) : null;
  }
  const hold = dec(input.holdPrice);
  if (hold === null || hold <= 0n) return null;
  const raw = divDown(spendable, hold);
  const base = raw === null ? 0n : floorToStep(raw, lot);
  return base > 0n ? str(base) : null;
}

/**
 * The dollar amount to put in the box for a Max of `base` coins: the cents that plan back to exactly that many coins,
 * rounded UP first (so the coins are not one lot short), else down. Never plans to more coins than `base`.
 */
export function dollarsForBase(base: string, price: string | null, lot: string): string | null {
  const coins = dec(base);
  const unitPrice = dec(price);
  const step = dec(lot);
  if (coins === null || unitPrice === null || step === null || coins <= 0n || unitPrice <= 0n || step <= 0n) return null;
  const exact = mulUp(coins, unitPrice);
  const candidates = [ceilPlaces(exact, 2), (exact / CENT) * CENT];
  for (const dollars of candidates) {
    const raw = divDown(dollars, unitPrice);
    if (raw !== null && floorToStep(raw, step) === coins) return str(dollars);
  }
  return null;
}

const CENT = 10n ** 16n;

/** The smallest coin amount a market accepts: the larger of the lot, the minimum size and the minimum order value at `price`. */
export function smallestOrder(input: {
  lot: string;
  minAmount: string | null;
  minCost: string | null;
  price: string | null;
}): string | null {
  const lot = dec(input.lot);
  if (lot === null || lot <= 0n) return null;
  let smallest = lot;
  const minAmount = dec(input.minAmount);
  if (minAmount !== null && minAmount > smallest) smallest = ceilToStep(minAmount, lot);
  const minCost = dec(input.minCost);
  const price = dec(input.price);
  if (minCost !== null && minCost > 0n && price !== null && price > 0n) {
    const needed = divUp(minCost, price);
    if (needed !== null && needed > smallest) smallest = ceilToStep(needed, lot);
  }
  return str(smallest);
}
