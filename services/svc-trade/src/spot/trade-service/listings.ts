/**
 * Listings, the operator surface: list a market and change its status.
 *
 * Moved out of `trade-service.ts` as it was (owner decision 2026-10-23): `TradeService` keeps one method per
 * function here, which passes itself as `svc`.
 */
import { formatAmount } from '@intafaced/ledger-client';
import { resolveOptionsListing } from '../options-listing.js';
import { resolveDatedFuturesListing } from '../../futures/dated-futures.js';
import { resolveFuturesFamily } from '../../futures/contract-family.js';
import { checkInsuranceFundedForListing } from '../../futures/insurance-listing-gate.js';
import { recordMarketStatusTransition } from '../../admin/status-history.js';
import { assertProductionUnsettledAssetClassListing } from '../forex-settlement.js';
import { toMarket, type MarketRow } from '../rows.js';
import { TradeError, type Market } from '../types.js';
import type { ListMarketInput, TradeServiceInternal } from '../trade-service.js';

// ── Listings (operator surface) ────────────────────────────────────────────

/**
 * List a market. Operator-only; there is no user-facing path to this.
 *
 * A listing decides the tick and lot grid, and therefore decides whether a
 * legal fill on this market can have a quote amount of zero. The database
 * enforces `tick x lot >= 1 wei` because a bad listing would otherwise lie
 * dormant until the first partial fill hit it in production.
 */
export async function listMarket(svc: TradeServiceInternal, input: ListMarketInput): Promise<Market> {
  const assetClass = input.assetClass ?? 'crypto';
  const paper = input.paper === true;
  const status = input.status ?? 'active';
  const kind = input.kind ?? 'spot';
  // Contract family first: an inverse request is refused before any ledger read.
  const familyTerms = resolveFuturesFamily({
    kind,
    quoteAsset: input.quoteAsset,
    family: input.futuresFamily,
    settleAsset: input.futuresSettleAsset,
    configuredSettleAssets: svc.futuresSettleAssets,
    paper,
  });
  // D26-P1-T7 / D-S-05: modelling forex/commodities is honest; production
  // active listing without P0-05 + fiat settle rails is the lie (§13 socket.forex-settlement).
  // paper=true (drills) and non-active status remain allowed. Never invent settlement.
  assertProductionUnsettledAssetClassListing({ assetClass, status, paper });
  // DIRECTION:33 — empty insurance fund → no real-money futures list.
  // Target size/schedule stay owner-open; any positive balance passes.
  const insuranceGate = await checkInsuranceFundedForListing({
    kind,
    status,
    paper,
    quoteAsset: input.quoteAsset,
    balance: (ref) => svc.ledger.balance(ref),
  });
  if (!insuranceGate.ok) {
    throw new TradeError(insuranceGate.reason, insuranceGate.code);
  }
  // trade.options: refuse kind=options until P0-05 law + D7 fixing; require
  // complete European terms so half-listed options cannot exist.
  // No IV surface, no pricing model, no invented settlement asset / matrix.
  const optionTerms = resolveOptionsListing({
    kind,
    settlementAssetLawConfigured: svc.optionsSettlementAssetLaw,
    settlementFixingConfigured: svc.optionsSettlementFixing,
    optionType: input.optionType,
    optionStyle: input.optionStyle,
    strike: input.optionStrike,
    expiryAt: input.optionExpiryAt,
    paper,
  });
  const datedTerms = resolveDatedFuturesListing({
    kind,
    futuresContractStyle: input.futuresContractStyle,
    expiryAt: input.futuresExpiryAt,
    settlementFixingConfigured: svc.futuresSettlementFixing,
    paper,
  });
  const rows = await svc.sql<MarketRow[]>`
    INSERT INTO trade.markets (
      symbol, base_asset, quote_asset, kind, tick_size, lot_size,
      min_qty, max_qty, min_notional, status, maker_bps, taker_bps, listed_at,
      asset_class, schedule, display_name, paper,
      option_type, option_style, option_strike, option_expiry_at, settlement_fixing,
      futures_contract_style, futures_expiry_at, futures_settlement_fixing,
      futures_family, futures_settle_asset
    ) VALUES (
      ${input.symbol}, ${input.baseAsset}, ${input.quoteAsset}, ${kind},
      ${formatAmount(input.tickSize)}::numeric, ${formatAmount(input.lotSize)}::numeric,
      ${formatAmount(input.minQty)}::numeric,
      ${input.maxQty == null ? null : formatAmount(input.maxQty)}::numeric,
      ${formatAmount(input.minNotional)}::numeric,
      ${status}, ${input.makerBps}, ${input.takerBps}, now(),
      ${assetClass}, ${input.schedule ?? 'crypto-24x7'},
      ${input.displayName ?? input.symbol}, ${paper},
      ${optionTerms?.optionType ?? null},
      ${optionTerms?.optionStyle ?? null},
      ${optionTerms == null ? null : formatAmount(optionTerms.strike)}::numeric,
      ${optionTerms?.expiryAt ?? null},
      ${optionTerms?.settlementFixing ?? null},
      ${datedTerms?.style ?? null},
      ${datedTerms?.expiryAt ?? null},
      ${datedTerms?.settlementFixing ?? null},
      ${familyTerms?.family ?? null},
      ${familyTerms?.settleAsset ?? null}
    )
    ON CONFLICT (symbol) DO UPDATE SET updated_at = now()
    RETURNING id, symbol, base_asset, quote_asset, kind, tick_size, lot_size,
              min_qty, max_qty, min_notional, status, maker_bps, taker_bps, listed_at,
              asset_class, schedule, paper,
              futures_contract_style, futures_expiry_at, futures_settlement_fixing,
              futures_family, futures_settle_asset, contract_size
  `;
  return toMarket(rows[0] as MarketRow);
}

/**
 * Halt, resume or delist a market.
 *
 * Halting does NOT touch open orders or their holds. An operator halting a
 * market is stopping new risk, not confiscating positions — the funds stay
 * held and the orders stay cancellable, which is the only behaviour that
 * lets a user out of a market the operator has frozen.
 */
export async function setMarketStatus(svc: TradeServiceInternal, marketId: string, status: Market['status']): Promise<Market> {
  // Load first: FX/commodity re-activate must not bypass socket.forex-settlement,
  // and empty-fund futures enable-to-active must refuse (DIRECTION:33).
  const existing = await svc.sql<MarketRow[]>`
    SELECT id, symbol, base_asset, quote_asset, kind, tick_size, lot_size,
           min_qty, max_qty, min_notional, status, maker_bps, taker_bps, listed_at,
           asset_class, schedule, paper,
           futures_contract_style, futures_expiry_at, futures_settlement_fixing,
           futures_family, futures_settle_asset, contract_size
      FROM trade.markets WHERE id = ${marketId}
  `;
  const current = existing[0];
  if (!current) throw new TradeError(`market ${marketId} not found`, 'trade.market_not_found');
  const currentMarket = toMarket(current);
  assertProductionUnsettledAssetClassListing({
    assetClass: current.asset_class,
    status,
    paper: currentMarket.paper,
  });
  const insuranceGate = await checkInsuranceFundedForListing({
    kind: currentMarket.kind,
    status,
    paper: currentMarket.paper,
    quoteAsset: currentMarket.quoteAsset,
    balance: (ref) => svc.ledger.balance(ref),
  });
  if (!insuranceGate.ok) {
    throw new TradeError(insuranceGate.reason, insuranceGate.code);
  }
  const rows = await svc.sql<MarketRow[]>`
    UPDATE trade.markets SET status = ${status}, updated_at = now() WHERE id = ${marketId}
    RETURNING id, symbol, base_asset, quote_asset, kind, tick_size, lot_size,
              min_qty, max_qty, min_notional, status, maker_bps, taker_bps, listed_at,
              asset_class, schedule, paper,
              futures_contract_style, futures_expiry_at, futures_settlement_fixing,
              futures_family, futures_settle_asset, contract_size
  `;
  const row = rows[0];
  if (!row) throw new TradeError(`market ${marketId} not found`, 'trade.market_not_found');
  await recordMarketStatusTransition(svc.sql, { marketId, fromStatus: current.status, toStatus: status });
  return toMarket(row);
}
