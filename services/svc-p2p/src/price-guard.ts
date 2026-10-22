import { compare, parseAmount, type Amount } from '@intafaced/ledger-client';

/**
 * P-ads-merchant-03 — FIXED-PRICE guard rails (pure, no I/O).
 *
 * Scope: fixed offers only. Floating price (premium on a svc-trade mark price)
 * is HELD-S2S: svc-p2p has no svc-trade edge yet, so nothing here sources a
 * reference. The reference is an input, and `null` is a first-class answer.
 *
 * Owner values (price guard band, deviation threshold) are `owner-decision`:
 * - blank policy is REFUSED on admin save (`p2p.config_unset`);
 * - an unset policy NEVER hides or refuses an ad (auto-hide disabled);
 * - no reference price never hides or refuses a fixed ad (fixed ads still work).
 */

export type PriceGuardCode = 'p2p.config_unset' | 'p2p.price_out_of_range' | 'p2p.invalid_amount';

export class PriceGuardError extends Error {
  constructor(
    message: string,
    readonly code: PriceGuardCode,
  ) {
    super(message);
    this.name = 'PriceGuardError';
  }
}

export interface PriceGuardPolicy {
  /** Max allowed |price - reference| / reference, in basis points (1..10000). */
  readonly maxDeviationBps: number;
  /** Optional absolute floor and ceiling on a fixed price (scaled Amount). */
  readonly minPrice: Amount | null;
  readonly maxPrice: Amount | null;
}

export interface PriceGuardPolicyInput {
  maxDeviationBps?: string | number | null;
  minPrice?: string | null;
  maxPrice?: string | null;
}

function blank(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

function parsePositiveAmount(raw: string, field: string): Amount {
  let value: Amount;
  try {
    value = parseAmount(raw.trim());
  } catch {
    throw new PriceGuardError(`${field} is not a decimal amount`, 'p2p.invalid_amount');
  }
  if (value <= 0n) throw new PriceGuardError(`${field} must be positive`, 'p2p.invalid_amount');
  return value;
}

/**
 * Validate a founder-ops policy on ADMIN SAVE. Blank deviation threshold refuses
 * (`p2p.config_unset`): there is no built-in default band.
 */
export function parsePriceGuardPolicy(input: PriceGuardPolicyInput): PriceGuardPolicy {
  if (blank(input.maxDeviationBps)) {
    throw new PriceGuardError('Price guard deviation threshold is unset (owner decision)', 'p2p.config_unset');
  }
  const raw = String(input.maxDeviationBps).trim();
  if (!/^\d+$/.test(raw)) throw new PriceGuardError('maxDeviationBps must be an integer', 'p2p.invalid_amount');
  const bps = Number(raw);
  if (!Number.isSafeInteger(bps) || bps < 1 || bps > 10_000) {
    throw new PriceGuardError('maxDeviationBps must be between 1 and 10000', 'p2p.invalid_amount');
  }
  const minPrice = blank(input.minPrice) ? null : parsePositiveAmount(input.minPrice as string, 'minPrice');
  const maxPrice = blank(input.maxPrice) ? null : parsePositiveAmount(input.maxPrice as string, 'maxPrice');
  if (minPrice !== null && maxPrice !== null && compare(minPrice, maxPrice) > 0) {
    throw new PriceGuardError('minPrice must not exceed maxPrice', 'p2p.invalid_amount');
  }
  return { maxDeviationBps: bps, minPrice, maxPrice };
}

export type PriceGuardVerdict =
  | { readonly ok: true; readonly checked: 'unset' | 'bounds' | 'bounds_and_deviation' }
  | { readonly ok: false; readonly reason: 'price_out_of_range'; readonly detail: 'below_min' | 'above_max' | 'deviation' };

export interface EvaluateFixedInput {
  /** Fixed offer price, fiat per unit (scaled). */
  price: Amount;
  /** null = no policy saved: never hides or refuses. */
  policy: PriceGuardPolicy | null;
  /** null/undefined = no reference available: deviation not checked. */
  referencePrice?: Amount | null;
}

/**
 * `offers.priceGuard.evaluate` for a FIXED offer. Exact integer math: deviation
 * is compared as |price - ref| * 10000 > ref * maxDeviationBps (no rounding).
 */
export function evaluateFixedOfferPrice(input: EvaluateFixedInput): PriceGuardVerdict {
  if (input.price <= 0n) throw new PriceGuardError('Offer price must be positive', 'p2p.invalid_amount');
  const policy = input.policy;
  if (policy === null) return { ok: true, checked: 'unset' };

  if (policy.minPrice !== null && compare(input.price, policy.minPrice) < 0) {
    return { ok: false, reason: 'price_out_of_range', detail: 'below_min' };
  }
  if (policy.maxPrice !== null && compare(input.price, policy.maxPrice) > 0) {
    return { ok: false, reason: 'price_out_of_range', detail: 'above_max' };
  }

  const ref = input.referencePrice;
  if (ref === undefined || ref === null || ref <= 0n) return { ok: true, checked: 'bounds' };

  const diff = input.price > ref ? input.price - ref : ref - input.price;
  if (diff * 10_000n > ref * BigInt(policy.maxDeviationBps)) {
    return { ok: false, reason: 'price_out_of_range', detail: 'deviation' };
  }
  return { ok: true, checked: 'bounds_and_deviation' };
}

/** Create/update path: refuse with `p2p.price_out_of_range` when the guard says no. */
export function assertFixedOfferPrice(input: EvaluateFixedInput): void {
  const verdict = evaluateFixedOfferPrice(input);
  if (!verdict.ok) {
    throw new PriceGuardError(`Fixed price is out of the allowed range (${verdict.detail})`, 'p2p.price_out_of_range');
  }
}
