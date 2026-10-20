/**
 * Contract family on the futures listing (D-instruments-03).
 *
 * Dated vs perpetual is `futuresContractStyle` (dated-futures.ts) and is not repeated here. This file only
 * answers "linear or inverse, and what does it settle in".
 *
 *   · `linear` is the only family that lists. A linear contract settles in its quote asset.
 *   · `inverse` refuses `trade.inverse_family_unsupported`. No inverse P&L formula is published, so none is
 *     invented here; the door stays shut until the owner publishes it.
 *   · The settle asset is never defaulted to anything but the quote asset. A settle asset that differs from
 *     the quote asset would need a conversion rule nobody has published, so it refuses.
 *   · USDC-settled linear lists only when the owner has configured USDC as a settle asset
 *     (`TRADE_FUTURES_SETTLE_ASSETS`). Blank config refuses; paper drills are exempt, as for dated fixing.
 */
import { TradeError, type Market } from '../spot/types.js';

export type FuturesFamily = 'linear' | 'inverse';

export const INVERSE_FAMILY_UNSUPPORTED = 'trade.inverse_family_unsupported' as const;
export const FUTURES_SETTLE_ASSET_MISMATCH = 'trade.futures_settle_asset_mismatch' as const;
export const FUTURES_SETTLE_ASSET_UNCONFIGURED = 'trade.futures_settle_asset_unconfigured' as const;
export const FUTURES_FAMILY_TERMS_INCOMPLETE = 'trade.futures_family_terms_incomplete' as const;

/** The one settle asset that needs an owner switch before a linear contract may list in it. */
export const USDC_SETTLE_ASSET = 'USDC' as const;

export interface FuturesFamilyTerms {
  readonly family: 'linear';
  readonly settleAsset: string;
}

export interface ResolveFuturesFamilyInput {
  readonly kind: Market['kind'];
  readonly quoteAsset: string;
  /** Omitted on kind=futures means linear: every listing that exists today is linear. */
  readonly family?: FuturesFamily | null;
  /** Omitted on a linear listing means the quote asset, and nothing else. */
  readonly settleAsset?: string | null;
  /** Owner-configured settle assets (`TRADE_FUTURES_SETTLE_ASSETS`). Empty = none configured. */
  readonly configuredSettleAssets?: readonly string[];
  readonly paper?: boolean;
}

/** Parse the owner's comma-separated settle-asset list. Blank is the empty list; nothing is filled in. */
export function parseConfiguredSettleAssets(raw: string | undefined): readonly string[] {
  return (raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Resolve the family terms, or null for a non-futures listing.
 *
 * Throws `trade.inverse_family_unsupported` for inverse before anything else, whatever the kind.
 */
export function resolveFuturesFamily(input: ResolveFuturesFamilyInput): FuturesFamilyTerms | null {
  const familyIn = input.family ?? null;
  if (familyIn === 'inverse') {
    throw new TradeError(
      'the inverse contract family is not supported: no inverse P&L formula is published, so none is invented here',
      INVERSE_FAMILY_UNSUPPORTED,
    );
  }
  if (familyIn !== null && familyIn !== 'linear') {
    throw new TradeError(
      'futures family must be linear (inverse is refused until the owner publishes its formula)',
      FUTURES_FAMILY_TERMS_INCOMPLETE,
    );
  }
  const settleIn = input.settleAsset?.trim() || null;

  if (input.kind !== 'futures') {
    if (familyIn !== null || settleIn !== null) {
      throw new TradeError(
        'family and settle asset are only valid when kind is futures — refuse half-shaped listings',
        FUTURES_FAMILY_TERMS_INCOMPLETE,
      );
    }
    return null;
  }

  const settleAsset = settleIn ?? input.quoteAsset;
  if (settleAsset !== input.quoteAsset) {
    throw new TradeError(
      `a linear contract settles in its quote asset ${input.quoteAsset}; settling in ${settleAsset} needs a conversion rule that is not published`,
      FUTURES_SETTLE_ASSET_MISMATCH,
    );
  }
  if (settleAsset === USDC_SETTLE_ASSET && input.paper !== true) {
    const configured = input.configuredSettleAssets ?? [];
    if (!configured.includes(USDC_SETTLE_ASSET)) {
      throw new TradeError(
        `${USDC_SETTLE_ASSET}-settled linear futures cannot be listed until ${USDC_SETTLE_ASSET} is configured as a settle asset (TRADE_FUTURES_SETTLE_ASSETS empty) — owner switch, never defaulted`,
        FUTURES_SETTLE_ASSET_UNCONFIGURED,
      );
    }
  }
  return { family: 'linear', settleAsset };
}
