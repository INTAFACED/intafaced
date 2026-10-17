/**
 * Read-only holdings for one caller.
 *
 * Balances come from packages/ledger-client (`balances` only — this file never
 * posts). Prices come from the injected source. An asset with no positive
 * price is `portfolio.price_unset` naming that asset. It is never valued at 0.
 * The read is for the user id passed in; nothing here accepts a second account.
 */

import { isNegative, isZero, parseAmount, type Balance } from '@intafaced/ledger-client';
import type { PortfolioHolding, PortfolioSnapshot } from './port.js';
import { formatWeight, weightUnit } from './weights.js';

export type HoldingsLedger = {
  balances(ownerType: 'user', ownerId: string): Promise<Balance[]>;
};

export type PortfolioPriceSource = {
  /** Decimal string for one unit of the asset, or null when no price is published. */
  price(assetId: string): Promise<string | null>;
};

export type HoldingsRead =
  | { readonly ok: true; readonly snapshot: PortfolioSnapshot }
  | { readonly ok: false; readonly code: 'portfolio.price_unset'; readonly asset: string };

function positivePrice(raw: string | null): bigint | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  try {
    const price = parseAmount(trimmed);
    if (isZero(price) || isNegative(price)) return null;
    return price;
  } catch {
    return null;
  }
}

/** Weights in the portfolio scale that sum to exactly one unit. */
function weightsFor(values: readonly bigint[]): bigint[] {
  const unit = weightUnit();
  const total = values.reduce((sum, value) => sum + value, 0n);
  if (total <= 0n) return values.map(() => 0n);
  const floors = values.map((value) => (value * unit) / total);
  let used = floors.reduce((sum, value) => sum + value, 0n);
  const remainders = values.map((value, index) => ({
    index,
    rem: (value * unit) % total,
  }));
  remainders.sort((a, b) => (a.rem === b.rem ? a.index - b.index : a.rem > b.rem ? -1 : 1));
  for (const row of remainders) {
    if (used >= unit) break;
    floors[row.index] = (floors[row.index] ?? 0n) + 1n;
    used += 1n;
  }
  return floors;
}

export async function readOwnHoldings(input: {
  ledger: HoldingsLedger;
  prices: PortfolioPriceSource;
  userId: string;
}): Promise<HoldingsRead> {
  const balances = await input.ledger.balances('user', input.userId);
  const amounts = new Map<string, bigint>();
  for (const balance of balances) {
    if (balance.account.kind !== 'available') continue;
    if (isZero(balance.amount) || isNegative(balance.amount)) continue;
    amounts.set(balance.account.assetId, (amounts.get(balance.account.assetId) ?? 0n) + balance.amount);
  }

  const assets = [...amounts.keys()].sort();
  const priced: Array<{ asset: string; value: bigint }> = [];
  for (const asset of assets) {
    const price = positivePrice(await input.prices.price(asset));
    if (price === null) return { ok: false, code: 'portfolio.price_unset', asset };
    const amount = amounts.get(asset) ?? 0n;
    // value = amount * price, both scaled by 10^18, product scaled back once.
    const value = (amount * price) / 10n ** 18n;
    if (value <= 0n) return { ok: false, code: 'portfolio.price_unset', asset };
    priced.push({ asset, value });
  }

  const weights = weightsFor(priced.map((row) => row.value));
  const holdings: PortfolioHolding[] = priced.map((row, index) => ({
    asset: row.asset,
    plane: 'custodial',
    weight: formatWeight(weights[index] ?? 0n),
  }));
  return { ok: true, snapshot: { holdings, unread: [] } };
}
