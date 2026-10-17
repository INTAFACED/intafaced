import type { Amount } from '@intafaced/ledger-client';
import { logRefusalSpec } from '../refusal-spec-log.js';
import { TradeError, type MarketKind } from './types.js';
import {
  OPTIONS_FIXING_UNCONFIGURED,
  OPTIONS_SETTLEMENT_LAW_UNSET,
  OPTIONS_TERMS_INCOMPLETE,
  type OptionStyle,
  type OptionType,
} from './options-policy.js';

export {
  OPTIONS_FIXING_UNCONFIGURED,
  OPTIONS_SETTLEMENT_LAW_UNSET,
  OPTIONS_TERMS_INCOMPLETE,
  type OptionStyle,
  type OptionType,
} from './options-policy.js';

/**
 * OPTIONS LISTING — refuse-closed until D26-P0-05 (settlement asset law).
 *
 * ── SOCKET §13 · `socket.options-settlement-asset-law` ──────────────────────
 * Full-collateral European options need no IV surface: payoff is mechanical once
 * a settlement price and settlement *asset* are known. P0-05 owns the ADR for
 * live instrument set, settlement asset, and refuse matrix. Agents do not invent
 * that law. Until the operator stamps that ADR is published
 * (`TRADE_OPTIONS_SETTLEMENT_ASSET_LAW` non-empty opaque id), kind=options cannot
 * be listed — even if D7 fixing and European terms are complete.
 *
 * After P0-05 is stamped: D7 fixing (`TRADE_OPTIONS_SETTLEMENT_FIXING`) must still
 * be configured, and the row must carry complete European contract terms so a
 * half-listed option cannot exist (mirrored by `markets_options_terms_ck`).
 *
 * Opaque stamps are never parsed for live set / settlement asset / refuse matrix
 * / source / window / payor — inventing those fields here would be the failure
 * this socket exists to prevent.
 *
 * Listing is not live trading: paper options may list without inventing a
 * settlement asset. Live listings still require P0-05 + D7.
 */

/**
 * First options-listing gate: P0-05 settlement-asset law must be stamped.
 *
 * Pin: `TRADE_OPTIONS_SETTLEMENT_FIXING` (and complete European terms) must not
 * unlock listing while the law stamp is empty/whitespace. Call this before any
 * fixing or terms check. Opaque stamp is never parsed for assets / matrix / D7.
 */
export function assertOptionsSettlementAssetLawStamped(settlementAssetLawConfigured: string): string {
  const assetLaw = settlementAssetLawConfigured.trim();
  if (assetLaw.length === 0) {
    logRefusalSpec('trade.options_settlement_law_unset');
    throw new TradeError(
      'Options cannot be listed yet: the settlement asset is not set. A fixing source alone does not turn listing on.',
      OPTIONS_SETTLEMENT_LAW_UNSET,
    );
  }
  return assetLaw;
}

export interface OptionsContractTerms {
  readonly optionType: OptionType;
  readonly optionStyle: OptionStyle;
  readonly strike: Amount;
  readonly expiryAt: Date;
  /** Opaque operator string from `TRADE_OPTIONS_SETTLEMENT_FIXING` — not parsed. */
  readonly settlementFixing: string;
}

/** Opaque paper-drill fixing stamp — not a settlement asset, not a live oracle. */
export const OPTIONS_PAPER_FIXING_STAMP = 'paper' as const;

export interface ResolveOptionsListingInput {
  readonly kind: MarketKind;
  /**
   * Opaque stamp that P0-05 ADR is published (`TRADE_OPTIONS_SETTLEMENT_ASSET_LAW`).
   * Empty / whitespace = unset → refuse live listings. Never parsed for assets.
   */
  readonly settlementAssetLawConfigured: string;
  /**
   * Deployment config for D7 fixing. Empty / whitespace = not configured.
   * Presence is the only signal — this function never invents source/window/account.
   */
  readonly settlementFixingConfigured: string;
  readonly optionType?: OptionType | null;
  readonly optionStyle?: OptionStyle | null;
  readonly strike?: Amount | null;
  readonly expiryAt?: Date | null;
  /**
   * Paper drills: listing is allowed without inventing settlement-asset law.
   * Live (`false` / omitted) still refuses when law is empty.
   */
  readonly paper?: boolean;
}

/**
 * Resolve option contract terms for a listing, or null for non-options.
 *
 * Throws `trade.options_settlement_law_unset` when kind is options and P0-05 law
 * is blank (SOCKET §13). Throws `trade.options_fixing_unconfigured` when fixing
 * is blank. Throws `trade.options_terms_incomplete` when terms are partial or
 * attached to a non-options kind.
 */
export function resolveOptionsListing(input: ResolveOptionsListingInput): OptionsContractTerms | null {
  const hasAnyTerm =
    input.optionType != null ||
    input.optionStyle != null ||
    input.strike != null ||
    (input.expiryAt != null && !Number.isNaN(input.expiryAt.getTime()));

  if (input.kind !== 'options') {
    if (hasAnyTerm) {
      throw new TradeError(
        'option contract terms are only valid when kind is options — refuse half-shaped listings',
        OPTIONS_TERMS_INCOMPLETE,
      );
    }
    return null;
  }

  // ── SOCKET §13 · `socket.options-settlement-asset-law` (D26-P0-05) ────────
  // Paper drills skip the live law stamp — they never settle an asset.
  // Live: law stamp first. Fixing env / terms must not short-circuit this refuse.
  const paper = input.paper === true;
  if (!paper) {
    assertOptionsSettlementAssetLawStamped(input.settlementAssetLawConfigured);
  }

  const fixing = paper ? input.settlementFixingConfigured.trim() || OPTIONS_PAPER_FIXING_STAMP : input.settlementFixingConfigured.trim();
  if (fixing.length === 0) {
    logRefusalSpec('trade.options_fixing_unconfigured');
    throw new TradeError(
      'Options cannot be listed yet: the settlement fixing source is not set (TRADE_OPTIONS_SETTLEMENT_FIXING is empty).',
      OPTIONS_FIXING_UNCONFIGURED,
    );
  }

  if (input.optionType !== 'call' && input.optionType !== 'put') {
    throw new TradeError('options listing requires optionType call|put — half-listed options are refused', OPTIONS_TERMS_INCOMPLETE);
  }

  // Default european when omitted: product title is European v1. Explicit non-european refuses.
  const optionStyle: OptionStyle = input.optionStyle ?? 'european';
  if (optionStyle !== 'european') {
    throw new TradeError('v1 options are european only — half-listed or unsupported style is refused', OPTIONS_TERMS_INCOMPLETE);
  }

  if (input.strike == null || input.strike <= 0n) {
    throw new TradeError('options listing requires strike > 0 — half-listed options are refused', OPTIONS_TERMS_INCOMPLETE);
  }

  if (!(input.expiryAt instanceof Date) || Number.isNaN(input.expiryAt.getTime())) {
    throw new TradeError('options listing requires a valid expiryAt — half-listed options are refused', OPTIONS_TERMS_INCOMPLETE);
  }

  return {
    optionType: input.optionType,
    optionStyle,
    strike: input.strike,
    expiryAt: input.expiryAt,
    settlementFixing: fixing,
  };
}
