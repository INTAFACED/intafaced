import { formatAmount, parseAmount, SCALE } from '@intafaced/ledger-client';
import { MerchantOpsError } from '../merchant-ops/errors.js';

/**
 * Pure price arithmetic for M-catalogue-02. Amounts are bigint at 18 decimals (the ledger scale), quantities are
 * whole numbers. Every model multiplies a whole quantity by an 18-decimal unit amount, so each line is exact; the
 * one rounding point (half-up to 18 decimals) is the total, and with whole quantities it never moves a digit.
 */
export const CATALOG_PRICE_MODELS = ['flat', 'per_seat', 'graduated', 'volume'] as const;
export type CatalogPriceModel = (typeof CATALOG_PRICE_MODELS)[number];
/** numeric(38,18): 20 integer digits. */
export const AMOUNT_MAX = 10n ** 20n * SCALE - 1n;
export const TIERS_MAX = 20;

export interface PriceTier {
  /** Inclusive upper bound of this tier, or null for the last, open tier. */
  upTo: number | null;
  unitAmount: string;
  flatAmount?: string | null;
}
export interface NormalTier {
  upTo: number | null;
  unitAmount: string;
  flatAmount: string;
}

const bad = (code: `pay.${string}`) => new MerchantOpsError(code, 'bad_request');

export function amount(value: string, code: `pay.${string}` = 'pay.catalog_price_amount_invalid'): bigint {
  if (typeof value !== 'string' || !/^\d{1,20}(\.\d{1,18})?$/.test(value.trim())) throw bad(code);
  const a = parseAmount(value.trim());
  if (a < 0n || a > AMOUNT_MAX) throw bad(code);
  return a;
}

/** Tiers start at zero, have no gap or overlap (each upTo strictly above the last), and end open. */
export function normalizeTiers(tiers: PriceTier[] | null | undefined): NormalTier[] {
  if (!Array.isArray(tiers) || tiers.length < 1 || tiers.length > TIERS_MAX) throw bad('pay.catalog_price_tiers_invalid');
  let prev = 0;
  return tiers.map((t, i) => {
    const last = i === tiers.length - 1;
    if (last ? t.upTo !== null : !(Number.isSafeInteger(t.upTo) && (t.upTo as number) > prev)) {
      throw bad('pay.catalog_price_tiers_invalid');
    }
    if (!last) prev = t.upTo as number;
    return {
      upTo: t.upTo,
      unitAmount: formatAmount(amount(t.unitAmount)),
      flatAmount: formatAmount(amount(t.flatAmount ?? '0')),
    };
  });
}

export interface QuoteLine {
  tier: number | null;
  quantity: number;
  unitAmount: string;
  flatAmount: string;
  amount: string;
}

/** The exact total for a whole quantity, and the lines that make it up. */
export function priceQuantity(
  model: CatalogPriceModel,
  unitAmount: string | null,
  tiers: NormalTier[] | null,
  quantity: number,
): { lines: QuoteLine[]; total: string } {
  const lines: QuoteLine[] = [];
  const line = (tier: number | null, q: number, unit: string, flat: string) => {
    const amt = BigInt(q) * parseAmount(unit) + parseAmount(flat);
    lines.push({ tier, quantity: q, unitAmount: unit, flatAmount: flat, amount: formatAmount(amt) });
    return amt;
  };
  let total = 0n;
  if (model === 'flat') total = line(null, quantity, '0', unitAmount!);
  else if (model === 'per_seat') total = line(null, quantity, unitAmount!, '0');
  else if (model === 'volume') {
    const i = tiers!.findIndex((t) => t.upTo === null || quantity <= t.upTo);
    const t = tiers![i]!;
    total = line(i, quantity, t.unitAmount, t.flatAmount);
  } else {
    let from = 0;
    for (let i = 0; i < tiers!.length && from < quantity; i++) {
      const t = tiers![i]!;
      const to = t.upTo === null ? quantity : Math.min(quantity, t.upTo);
      total += line(i, to - from, t.unitAmount, t.flatAmount);
      from = to;
    }
  }
  if (total > AMOUNT_MAX) throw bad('pay.catalog_quote_total_too_large');
  return { lines, total: formatAmount(total) };
}
