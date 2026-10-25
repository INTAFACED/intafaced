import {
  CHECKOUT_METHODS,
  type CheckoutMethodConnection,
  type CheckoutMethodId,
  type CheckoutMethodNotice,
  type CheckoutMethodOffer,
  type CheckoutMethodRule,
} from '@intafaced/contracts';
import { FIAT_CURRENCIES } from '@intafaced/config';
import { parseAmount } from '@intafaced/ledger-client';
import { assertRailMayAcceptPublicPayment, PUBLIC_CHECKOUT_CAPABILITIES, type ValueMovementPolicy } from '../rails/posture.js';
import type { RailRegistry } from '../rails/registry.js';
import type { RailRoutingProfile } from '../routing/decide.js';

/**
 * The method catalogue and the one rule that says what a payer is offered (M-adv-payments-core-11, J-merchant-04
 * step 7). Pure: the business's saved methods and the platform's connected rails come in, the offer goes out. The hosted
 * page and the portal's preview both ask it, so the owner reads exactly what a payer would be offered.
 */

interface CatalogueEntry {
  /** The payment currencies the method is for. */
  readonly currencies: 'crypto' | 'fiat';
  /** What the method waits for while no rail takes it. */
  readonly notice: CheckoutMethodNotice;
}

export const METHOD_CATALOGUE: Readonly<Record<CheckoutMethodId, CatalogueEntry>> = {
  crypto: { currencies: 'crypto', notice: 'rail.crypto' },
  card: { currencies: 'fiat', notice: 'rail.card' },
  bank_debit: { currencies: 'fiat', notice: 'rail.bank' },
  // Instalments are paid by card through an outside provider: the card rail is the missing piece.
  pay_later: { currencies: 'fiat', notice: 'rail.card' },
  // A push the payer sends from their own bank with the payment's reference (J-merchant-04 step 6).
  bank_transfer: { currencies: 'fiat', notice: 'rail.bank' },
};

const FIAT = new Set(FIAT_CURRENCIES.map((c) => c.code.toUpperCase()));

/** A method the platform can take on the public checkout: the countries its rail declares (`'*'` is everywhere). */
export interface MethodRail {
  readonly countries: readonly string[];
}

/** The platform's connected methods, keyed by method. A method missing here has no rail. */
export type MethodRails = ReadonlyMap<string, MethodRail>;

/**
 * The methods the public checkout can take, from what the operator declared: each rail on the checkout list
 * (`PAY_CHECKOUT_RAILS`) that is registered, can take a public payment, is not absent and that this environment lets take
 * strangers' money, under the method it writes, with the countries its routing profile declares. Health is left out: a
 * rail that is down for a minute is still connected, and the session open refuses by name while it is down.
 */
export function methodRailsOf(input: {
  readonly checkoutRails: readonly { readonly railId: string; readonly method: string }[];
  readonly profiles: readonly RailRoutingProfile[];
  readonly rails: RailRegistry;
  readonly policy: ValueMovementPolicy;
  /** RC-merchant-08: the rails the business's category allows; omitted, no category limit. */
  readonly onlyRails?: readonly string[];
}): MethodRails {
  const out = new Map<string, { countries: string[] }>();
  for (const entry of input.checkoutRails) {
    const railId = entry.railId;
    // Read the way smart routing reads them: methods in lower case, countries in upper case, both trimmed.
    const method = entry.method.trim().toLowerCase();
    if (input.onlyRails && !input.onlyRails.includes(railId)) continue;
    if (!input.rails.has(railId)) continue;
    const adapter = input.rails.get(railId);
    if (adapter.mode === 'absent' || !PUBLIC_CHECKOUT_CAPABILITIES.every((c) => adapter.capabilities.includes(c))) continue;
    try {
      assertRailMayAcceptPublicPayment(adapter, input.policy);
    } catch {
      continue;
    }
    const profile = input.profiles.find((p) => p.railId === railId);
    if (!profile?.methods?.some((m) => m.trim().toLowerCase() === method)) continue;
    const taken = out.get(method) ?? { countries: [] };
    for (const raw of profile.countries ?? []) {
      const country = raw.trim().toUpperCase();
      if (country && !taken.countries.includes(country)) taken.countries.push(country);
    }
    out.set(method, taken);
  }
  return out;
}

export function connectionOf(method: CheckoutMethodId, rails: MethodRails): CheckoutMethodConnection {
  return rails.has(method) ? { state: 'connected' } : { state: 'not_connected', notice: METHOD_CATALOGUE[method].notice };
}

/**
 * The business's methods before its first save: the catalogue order, with the methods the platform can take on and the
 * rest off. That is what the checkout offered before methods could be set, so nothing changes for a business until it
 * saves.
 */
export function defaultRules(rails: MethodRails): CheckoutMethodRule[] {
  return CHECKOUT_METHODS.map((method) => ({
    method,
    enabled: rails.has(method),
    ruleAsset: null,
    minAmount: null,
    maxAmount: null,
  }));
}

export interface OfferRequest {
  readonly country: string;
  readonly currency: string;
  /** Decimal string. Without it the minimum and maximum are not applied. */
  readonly amount?: string;
}

/**
 * What a payer is offered, in the business's order. A method is left out when it is off, not for the payment's
 * currency, outside its rule, or (when a rail takes it) its rail does not serve the payer's country. A method with no
 * rail is still offered, as not connected with its notice, so the payer reads why it cannot be used; it is never
 * payable.
 */
export function offerFor(rules: readonly CheckoutMethodRule[], rails: MethodRails, request: OfferRequest): CheckoutMethodOffer {
  const currency = request.currency.trim().toUpperCase();
  const country = request.country.trim().toUpperCase();
  const isFiat = FIAT.has(currency);
  const amount = request.amount === undefined ? undefined : parseAmount(request.amount);
  const offered: CheckoutMethodOffer['offered'][number][] = [];
  const leftOut: CheckoutMethodOffer['leftOut'][number][] = [];
  for (const rule of rules) {
    const entry = METHOD_CATALOGUE[rule.method];
    const rail = rails.get(rule.method);
    const inRule = rule.ruleAsset !== null && rule.ruleAsset === currency && amount !== undefined;
    const reason = !rule.enabled
      ? 'off'
      : (entry.currencies === 'fiat') !== isFiat
        ? 'currency'
        : rail && !rail.countries.includes('*') && !rail.countries.includes(country)
          ? 'country'
          : inRule && rule.minAmount !== null && amount < parseAmount(rule.minAmount)
            ? 'below_min'
            : inRule && rule.maxAmount !== null && amount > parseAmount(rule.maxAmount)
              ? 'above_max'
              : null;
    if (reason) leftOut.push({ method: rule.method, reason });
    else offered.push({ method: rule.method, connection: connectionOf(rule.method, rails) });
  }
  return { offered, leftOut };
}

/** The offered methods a payer can actually pay with, in order. */
export function payableMethods(offer: CheckoutMethodOffer): CheckoutMethodId[] {
  return offer.offered.filter((o) => o.connection.state === 'connected').map((o) => o.method);
}
