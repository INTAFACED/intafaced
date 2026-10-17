import { logRefusalSpec } from '../refusal-spec-log.js';
import { TradeError, type Market } from './types.js';

/**
 * D26-P1-T7 · `trade.forex` — refuse-closed until settlement law.
 *
 * Product-complete forex is **only** after:
 *   1. **D26-P0-05** — options/forex settlement asset law (ADR: live set,
 *      settlement asset, refuse matrix), and
 *   2. **Fiat settle rails posture** — a real rail that can settle the chosen
 *      asset (not `PAY_CRYPTO_ASSETS` accidentally mapping EUR → a euro
 *      stablecoin).
 *
 * Until both exist, production forex/commodity listing and place stay refuse-
 * closed. Modelling (`paper=true`) and non-active statuses remain honest.
 *
 * §13 — `socket.forex-settlement`. Do **not** invent the settlement asset
 * (stablecoin-margined vs true fiat omnibus). That is owner law (D8 / P0-05).
 */

export const FOREX_SETTLEMENT_SOCKET = 'socket.forex-settlement' as const;

/** Error code shared with D-S-05 listing/place refuse (#1169 / #1220). */
export const FOREX_SETTLEMENT_REFUSE_CODE = 'trade.unsettled_asset_class_listing' as const;

export const FOREX_SETTLEMENT_RESIDUAL =
  'Forex and commodity trading is not available yet: the settlement asset and fiat settlement rails are not set.';

export type ForexSettlementStatus = {
  /** Always false until P0-05 ADR + fiat rails are owner-published. */
  published: false;
  socket: typeof FOREX_SETTLEMENT_SOCKET;
  statusLine: string;
  residual: string;
  blockers: readonly ['settlement_asset_law', 'fiat_settle_rails'];
  /** What remains legal while the socket is open. */
  allowed: {
    paperListing: true;
    nonActiveListing: true;
    productionActiveListing: false;
    productionPlace: false;
  };
};

/**
 * Public posture — same shape as OTC/copy deskStatus refuse-closed surfaces.
 * Never reports a publishable settlement asset; there is none until P0-05.
 */
export function forexSettlementStatus(): ForexSettlementStatus {
  logRefusalSpec('trade.unsettled_asset_class_listing');
  return {
    published: false,
    socket: FOREX_SETTLEMENT_SOCKET,
    statusLine: `published=0 socket=${FOREX_SETTLEMENT_SOCKET} residual=settlement_asset_law+fiat_settle_rails`,
    residual: FOREX_SETTLEMENT_RESIDUAL,
    blockers: ['settlement_asset_law', 'fiat_settle_rails'],
    allowed: {
      paperListing: true,
      nonActiveListing: true,
      productionActiveListing: false,
      productionPlace: false,
    },
  };
}

function isUnsettledAssetClass(assetClass: Market['assetClass'] | string): boolean {
  return assetClass === 'forex' || assetClass === 'commodity';
}

/**
 * NEW production (active, non-paper) forex/commodity listings — refuse.
 * Paper drills and pending/halted/delisted rows stay allowed (model without open risk).
 */
export function assertProductionUnsettledAssetClassListing(input: {
  assetClass: Market['assetClass'] | string;
  status: Market['status'] | string;
  paper: boolean;
}): void {
  if (!isUnsettledAssetClass(input.assetClass)) return;
  if (input.paper) return;
  if (input.status !== 'active') return;
  logRefusalSpec('trade.unsettled_asset_class_listing');
  throw new TradeError(
    `${input.assetClass} cannot be listed for production trading yet: the settlement asset and fiat settlement rails are not set. List it as paper, or as pending or halted.`,
    FOREX_SETTLEMENT_REFUSE_CODE,
  );
}

/**
 * Place / convert / TWAP on an already-seeded production FX/commodity market.
 * Seeds stay `active` in DB; this is the hold-path seal that does not invent rails.
 */
export function assertSettlementRails(market: Pick<Market, 'symbol' | 'assetClass' | 'paper'>): void {
  if (market.paper) return;
  if (!isUnsettledAssetClass(market.assetClass)) return;
  logRefusalSpec('trade.unsettled_asset_class_listing');
  throw new TradeError(
    `${market.symbol} is ${market.assetClass} and cannot be traded yet: the settlement asset and fiat settlement rails are not set.`,
    FOREX_SETTLEMENT_REFUSE_CODE,
  );
}
