/**
 * trade.options product policy — settlement law honesty (SOCKET §13).
 *
 * Consolidates refuse codes and public posture from `options-listing.ts`.
 * Does not invent live set, settlement asset, refuse matrix, D7 fixing source, or IV surface.
 */

import { logRefusalSpec } from '../refusal-spec-log.js';

/** Settlement-asset law socket. The spec id stays in the server log. */
export const OPTIONS_SETTLEMENT_SOCKET = 'socket.options-settlement-asset-law' as const;

/** SOCKET §13 pin — keep this code; do not invent a second refuse. */
export const OPTIONS_SETTLEMENT_LAW_UNSET = 'trade.options_settlement_law_unset' as const;

/** D7 fixing env blank after P0-05 is stamped. */
export const OPTIONS_FIXING_UNCONFIGURED = 'trade.options_fixing_unconfigured' as const;

/** Half-listed or invalid contract terms on kind=options. */
export const OPTIONS_TERMS_INCOMPLETE = 'trade.options_terms_incomplete' as const;

export const OPTIONS_SETTLEMENT_RESIDUAL =
  'Options stay closed until the settlement asset, the fixing source, and complete European terms are set.';

export type OptionType = 'call' | 'put';

/** v1 title is European only — American is not modelled. */
export type OptionStyle = 'european';

export type OptionsPolicySummary = {
  readonly socket: typeof OPTIONS_SETTLEMENT_SOCKET;
  readonly settlementLawUnsetCode: typeof OPTIONS_SETTLEMENT_LAW_UNSET;
  readonly fixingUnconfiguredCode: typeof OPTIONS_FIXING_UNCONFIGURED;
  readonly termsIncompleteCode: typeof OPTIONS_TERMS_INCOMPLETE;
  readonly settlementAssetLawStamped: boolean;
  readonly settlementFixingConfigured: boolean;
  readonly statusLine: string;
  readonly residual: typeof OPTIONS_SETTLEMENT_RESIDUAL;
  readonly blockers: readonly ['settlement_asset_law', 'settlement_fixing', 'european_terms'];
  readonly allowed: {
    readonly nonOptionsListing: true;
    readonly optionsListing: boolean;
    readonly optionsOrders: boolean;
    readonly paperOptionsOrders: true;
    readonly liveOptionsOrders: false;
  };
  readonly europeanOnly: true;
  readonly fullCollateralV1: true;
  readonly inventsLiveSet: false;
  readonly inventsSettlementAsset: false;
  readonly inventsIvSurface: false;
  readonly ordersStillRefuseUntilEngine: false;
  readonly liveOrdersStillRefuse: true;
  readonly paperEngine: true;
};

/** Public trade.options policy door — mirrors listing gates only, not trading engine. */
export function describeOptionsPolicy(input?: {
  readonly settlementAssetLawConfigured?: string;
  readonly settlementFixingConfigured?: string;
}): OptionsPolicySummary {
  const lawStamped = (input?.settlementAssetLawConfigured ?? '').trim().length > 0;
  const fixingConfigured = (input?.settlementFixingConfigured ?? '').trim().length > 0;
  if (!lawStamped) logRefusalSpec('trade.options_settlement_law_unset');
  if (!fixingConfigured) logRefusalSpec('trade.options_fixing_unconfigured');
  const listingAllowed = lawStamped && fixingConfigured;
  return {
    socket: OPTIONS_SETTLEMENT_SOCKET,
    settlementLawUnsetCode: OPTIONS_SETTLEMENT_LAW_UNSET,
    fixingUnconfiguredCode: OPTIONS_FIXING_UNCONFIGURED,
    termsIncompleteCode: OPTIONS_TERMS_INCOMPLETE,
    settlementAssetLawStamped: lawStamped,
    settlementFixingConfigured: fixingConfigured,
    statusLine: `socket=${OPTIONS_SETTLEMENT_SOCKET} lawStamped=${lawStamped ? 1 : 0} fixingConfigured=${fixingConfigured ? 1 : 0}`,
    residual: OPTIONS_SETTLEMENT_RESIDUAL,
    blockers: ['settlement_asset_law', 'settlement_fixing', 'european_terms'],
    allowed: {
      nonOptionsListing: true,
      optionsListing: listingAllowed,
      optionsOrders: true,
      paperOptionsOrders: true,
      liveOptionsOrders: false,
    },
    europeanOnly: true,
    fullCollateralV1: true,
    inventsLiveSet: false,
    inventsSettlementAsset: false,
    inventsIvSurface: false,
    ordersStillRefuseUntilEngine: false,
    liveOrdersStillRefuse: true,
    paperEngine: true,
  };
}
