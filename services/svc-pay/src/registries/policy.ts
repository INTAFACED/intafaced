import { canonicalDecimal, compareDecimal, isPositiveDecimal } from './decimal.js';
import type { FeeEstimateSource } from './schemas.js';

/**
 * Pure rules for the registries. No I/O: what counts as fully configured, and
 * which changes need a second founder. Tested directly.
 *
 * BLANK REFUSES. A null limit, confirmation count, fee source or payout cap is
 * "not configured". It is never read as zero, unlimited or a default.
 */

/** The only modes a stored venue may hold today. `live` exists as a type value and is refused on write. */
export type StoredVenueMode = 'disabled' | 'testnet';

export interface VenueState {
  venueId: string;
  displayName: string;
  mode: StoredVenueMode;
  priority: number;
  enabled: boolean;
  minOrder: string | null;
  maxOrder: string | null;
  supportedPairs: string[];
}

export interface NetworkState {
  networkId: string;
  displayName: string;
  assetCodes: string[];
  confirmationsRequired: number | null;
  enabled: boolean;
  feeEstimateSource: FeeEstimateSource | null;
  feeEstimateAmount: string | null;
}

export interface WalletRouteState {
  assetCode: string;
  networkId: string;
  payoutAllowed: boolean;
  merchantAllow: string[];
  merchantDeny: string[];
  maxSinglePayout: string | null;
}

const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].sort();
const sortedUniqueLower = (values: readonly string[]): string[] => sortedUnique(values.map((v) => v.toLowerCase()));
const dec = (v: string | null): string | null => (v === null ? null : canonicalDecimal(v));

export function normalizeVenue(s: VenueState): VenueState {
  return { ...s, minOrder: dec(s.minOrder), maxOrder: dec(s.maxOrder), supportedPairs: sortedUnique(s.supportedPairs) };
}
export function normalizeNetwork(s: NetworkState): NetworkState {
  return { ...s, assetCodes: sortedUnique(s.assetCodes), feeEstimateAmount: dec(s.feeEstimateAmount) };
}
export function normalizeWalletRoute(s: WalletRouteState): WalletRouteState {
  return {
    ...s,
    merchantAllow: sortedUniqueLower(s.merchantAllow),
    merchantDeny: sortedUniqueLower(s.merchantDeny),
    maxSinglePayout: dec(s.maxSinglePayout),
  };
}

// ── "fully configured" ──────────────────────────────────────────────────────
export function venueMissing(s: VenueState): string[] {
  const out: string[] = [];
  if (s.mode !== 'testnet') out.push('mode');
  if (s.minOrder === null) out.push('min_order');
  if (s.maxOrder === null || !isPositiveDecimal(s.maxOrder)) out.push('max_order');
  if (s.supportedPairs.length === 0) out.push('supported_pairs');
  return out;
}
export const isVenueRoutable = (s: VenueState): boolean => s.enabled && venueMissing(s).length === 0;

export function networkMissing(s: NetworkState): string[] {
  const out: string[] = [];
  if (s.assetCodes.length === 0) out.push('asset_codes');
  if (s.confirmationsRequired === null) out.push('confirmations_required');
  if (s.feeEstimateSource === null || (s.feeEstimateSource === 'fixed' && s.feeEstimateAmount === null)) out.push('fee_estimate_source');
  return out;
}
export const isNetworkRoutable = (s: NetworkState): boolean => s.enabled && networkMissing(s).length === 0;

export function walletRouteMissing(s: WalletRouteState): string[] {
  const out: string[] = [];
  if (s.maxSinglePayout === null || !isPositiveDecimal(s.maxSinglePayout)) out.push('max_single_payout');
  return out;
}
export const isWalletRouteRoutable = (s: WalletRouteState): boolean => s.payoutAllowed && walletRouteMissing(s).length === 0;

// ── which changes need a second founder ─────────────────────────────────────
/**
 * Rule of thumb, stated once:
 *   - turning an entry on or off ALWAYS needs a second founder, as does a venue
 *     mode change;
 *   - while an entry is on (before and after), anything that LOOSENS what it may
 *     route needs one too: a higher cap, a lower minimum, a lower confirmation
 *     count, more pairs or assets, a wider allow list, a shorter deny list,
 *     and a blank limit filled in (it makes the entry routable);
 *   - tightening, renaming and re-ordering do not.
 * A change to an entry that is off before and after is inert, so it does not.
 * The second founder approves the exact after-state (the approval is bound to its hash).
 */
const added = (before: readonly string[], after: readonly string[]) => after.some((v) => !before.includes(v));

/** Loosening for an upper bound (max order, max payout): blank to value, or a higher value. */
function capLoosened(before: string | null, after: string | null): boolean {
  if (after === null) return false;
  if (before === null) return true;
  return compareDecimal(after, before) > 0;
}
/** Loosening for a lower bound (min order): blank to value, or a lower value. */
function floorLoosened(before: string | null, after: string | null): boolean {
  if (after === null) return false;
  if (before === null) return true;
  return compareDecimal(after, before) < 0;
}

export function venueDualReasons(before: VenueState | null, after: VenueState): string[] {
  if (before === null) return [];
  const out: string[] = [];
  if (before.enabled !== after.enabled) out.push(after.enabled ? 'enabled' : 'disabled');
  if (before.mode !== after.mode) out.push('mode_changed');
  if (before.enabled && after.enabled) {
    if (floorLoosened(before.minOrder, after.minOrder)) out.push('min_order_loosened');
    if (capLoosened(before.maxOrder, after.maxOrder)) out.push('max_order_loosened');
    if (added(before.supportedPairs, after.supportedPairs)) out.push('pairs_added');
  }
  return out;
}

export function networkDualReasons(before: NetworkState | null, after: NetworkState): string[] {
  if (before === null) return [];
  const out: string[] = [];
  if (before.enabled !== after.enabled) out.push(after.enabled ? 'enabled' : 'disabled');
  if (before.enabled && after.enabled) {
    const b = before.confirmationsRequired;
    const a = after.confirmationsRequired;
    if (a !== null && (b === null || a < b)) out.push('confirmations_lowered');
    if (after.feeEstimateSource !== before.feeEstimateSource || after.feeEstimateAmount !== before.feeEstimateAmount) {
      out.push('fee_estimate_changed');
    }
    if (added(before.assetCodes, after.assetCodes)) out.push('assets_added');
  }
  return out;
}

export function walletRouteDualReasons(before: WalletRouteState | null, after: WalletRouteState): string[] {
  if (before === null) return [];
  const out: string[] = [];
  if (before.payoutAllowed !== after.payoutAllowed) out.push(after.payoutAllowed ? 'payout_allowed' : 'payout_disallowed');
  if (before.payoutAllowed && after.payoutAllowed) {
    if (capLoosened(before.maxSinglePayout, after.maxSinglePayout)) out.push('max_single_payout_loosened');
    if (added(before.merchantAllow, after.merchantAllow)) out.push('allow_list_widened');
    if (before.merchantDeny.some((m) => !after.merchantDeny.includes(m))) out.push('deny_list_shortened');
  }
  return out;
}

// ── payout decision (used by the reader; pure so it can be tested alone) ────
export type PayoutRefusalCode =
  | 'registries.payout_no_route'
  | 'registries.payout_network_not_routable'
  | 'registries.payout_asset_not_on_network'
  | 'registries.payout_not_allowed'
  | 'registries.payout_limit_blank'
  | 'registries.payout_over_limit'
  | 'registries.payout_merchant_denied'
  | 'registries.payout_merchant_not_allowed';

export function decidePayout(
  route: WalletRouteState | null,
  network: NetworkState | null,
  request: { merchantId: string; amount: string },
): { allowed: true } | { allowed: false; code: PayoutRefusalCode } {
  if (route === null) return { allowed: false, code: 'registries.payout_no_route' };
  if (network === null || !isNetworkRoutable(network)) return { allowed: false, code: 'registries.payout_network_not_routable' };
  if (!network.assetCodes.includes(route.assetCode)) return { allowed: false, code: 'registries.payout_asset_not_on_network' };
  if (!route.payoutAllowed) return { allowed: false, code: 'registries.payout_not_allowed' };
  if (walletRouteMissing(route).length > 0) return { allowed: false, code: 'registries.payout_limit_blank' };
  const merchant = request.merchantId.toLowerCase();
  if (route.merchantDeny.includes(merchant)) return { allowed: false, code: 'registries.payout_merchant_denied' };
  if (route.merchantAllow.length > 0 && !route.merchantAllow.includes(merchant)) {
    return { allowed: false, code: 'registries.payout_merchant_not_allowed' };
  }
  if (compareDecimal(request.amount, route.maxSinglePayout!) > 0) return { allowed: false, code: 'registries.payout_over_limit' };
  return { allowed: true };
}
